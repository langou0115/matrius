import { spawn } from 'node:child_process';
import { opendir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';

import {
  LOCAL_WORK_HOST_ID,
  type WorkContentSearchFileResult,
  type WorkContentSearchMatch,
  type WorkContentSearchRequest,
  type WorkContentSearchResponse,
} from '../../contract/work-projects';
import type { AppDatabase } from '../db/client';
import { requireWorkProjectRow } from '../db/repositories/projects';
import { AppError, invalid } from '../errors';
import { resolveLocalTarget } from './host-fs';

const INSTANCE_ID = 1;
const MAX_TOTAL_MATCHES = 500;
const MAX_MATCHES_PER_FILE = 100;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_LENGTH = 400;
const RG_TIMEOUT_MS = 8_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.vite', '__pycache__', '.cache']);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('**/', '(?:.*/)?')
    .replaceAll('**', '.*')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]');
  return new RegExp(`(?:^|/)${escaped}$`, 'iu');
}

function parseGlobList(raw?: string): RegExp[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(globToRegExp);
}

function runRipgrepSearch(
  root: string,
  input: WorkContentSearchRequest,
  signal?: AbortSignal,
): Promise<WorkContentSearchResponse | null> {
  return new Promise((resolveResult) => {
    const args = ['--json', '--max-count', String(MAX_MATCHES_PER_FILE), '--max-filesize', '512K'];
    if (!input.caseSensitive) args.push('--ignore-case');
    if (!input.regex) args.push('--fixed-strings');
    if (input.include?.trim()) {
      for (const glob of input.include.split(',').map((item) => item.trim()).filter(Boolean)) {
        args.push('--glob', glob);
      }
    }
    if (input.exclude?.trim()) {
      for (const glob of input.exclude.split(',').map((item) => item.trim()).filter(Boolean)) {
        args.push('--glob', `!${glob}`);
      }
    }
    args.push('--', input.query, '.');

    let settled = false;
    const finish = (value: WorkContentSearchResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolveResult(value);
    };

    const child = spawn('rg', args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const onAbort = () => {
      child.kill();
      finish({ files: [], totalMatches: 0, truncated: false });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill();
      finish(buildResult(true));
    }, RG_TIMEOUT_MS);

    const byFile = new Map<string, WorkContentSearchFileResult>();
    let totalMatches = 0;
    let truncated = false;
    let buffer = '';

    const buildResult = (forceTruncated = false): WorkContentSearchResponse => ({
      files: Array.from(byFile.values()),
      totalMatches,
      truncated: truncated || forceTruncated,
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        finish(null);
      } else {
        finish(null);
      }
    });

    const processLine = (line: string): boolean => {
      if (!line.trim()) return true;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            lines?: { text?: string };
            line_number?: number;
            submatches?: Array<{ start?: number; end?: number }>;
          };
        };
        if (parsed.type !== 'match' || !parsed.data?.path?.text || !parsed.data.line_number) return true;
        const relPath = parsed.data.path.text.replace(/^\.[\\/]/u, '').replaceAll('\\', '/');
        const fullPath = join(root, relPath);
        const rawLine = (parsed.data.lines?.text ?? '').replace(/\r?\n$/u, '');
        const text = rawLine.length > MAX_LINE_LENGTH ? `${rawLine.slice(0, MAX_LINE_LENGTH)}…` : rawLine;
        const sub = parsed.data.submatches?.[0];
        const column = (sub?.start ?? 0) + 1;
        const matchLength = Math.max(1, (sub?.end ?? 0) - (sub?.start ?? 0));
        let entry = byFile.get(relPath);
        if (!entry) {
          entry = { path: fullPath, relativePath: relPath, name: basename(fullPath), matches: [] };
          byFile.set(relPath, entry);
        }
        entry.matches.push({ line: parsed.data.line_number, column, matchLength, text });
        totalMatches += 1;
        if (totalMatches >= MAX_TOTAL_MATCHES) {
          truncated = true;
          child.kill();
          finish(buildResult(true));
          return false;
        }
      } catch {
        // Ignore malformed json lines.
      }
      return true;
    };

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!processLine(line)) return;
      }
    });

    child.on('close', (code) => {
      if (buffer.trim()) {
        if (!processLine(buffer)) return;
      }
      if (code !== 0 && code !== 1 && totalMatches === 0) {
        finish(null);
        return;
      }
      finish(buildResult());
    });
  });
}

async function runFallbackNodeSearch(
  root: string,
  input: WorkContentSearchRequest,
  signal?: AbortSignal,
): Promise<WorkContentSearchResponse> {
  let matcher: RegExp;
  try {
    matcher = new RegExp(
      input.regex ? input.query : escapeRegExp(input.query),
      input.caseSensitive ? 'g' : 'gi',
    );
  } catch {
    throw invalid('正则表达式语法无效。');
  }

  const includeGlobs = parseGlobList(input.include);
  const excludeGlobs = parseGlobList(input.exclude);
  const files: WorkContentSearchFileResult[] = [];
  let totalMatches = 0;
  let truncated = false;

  const queue: string[] = [root];
  while (queue.length > 0 && !truncated) {
    if (signal?.aborted) break;
    const dir = queue.shift()!;
    let handle;
    try {
      handle = await opendir(dir);
    } catch {
      continue;
    }
    for await (const entry of handle) {
      if (signal?.aborted || truncated) break;
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name.toLowerCase())) {
          queue.push(fullPath);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (includeGlobs.length > 0 && !includeGlobs.some((re) => re.test(relPath))) continue;
      if (excludeGlobs.some((re) => re.test(relPath))) continue;

      try {
        const info = await stat(fullPath);
        if (info.size === 0 || info.size > MAX_FILE_BYTES) continue;
        const buf = await readFile(fullPath);
        // Skip likely binary files (null byte in first 8KB).
        if (buf.subarray(0, 8192).includes(0)) continue;
        const content = buf.toString('utf8');
        const lines = content.split(/\r?\n/u);
        const matches: WorkContentSearchMatch[] = [];
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
          const lineText = lines[lineIdx];
          matcher.lastIndex = 0;
          const hit = matcher.exec(lineText);
          if (!hit) continue;
          matches.push({
            line: lineIdx + 1,
            column: hit.index + 1,
            matchLength: Math.max(1, hit[0].length),
            text: lineText.length > MAX_LINE_LENGTH ? `${lineText.slice(0, MAX_LINE_LENGTH)}…` : lineText,
          });
          totalMatches += 1;
          if (matches.length >= MAX_MATCHES_PER_FILE || totalMatches >= MAX_TOTAL_MATCHES) {
            if (totalMatches >= MAX_TOTAL_MATCHES) truncated = true;
            break;
          }
        }
        if (matches.length > 0) {
          files.push({
            path: fullPath,
            relativePath: relPath,
            name: entry.name,
            matches,
          });
        }
      } catch {
        // Ignore unreadable files.
      }
    }
  }

  return { files, totalMatches, truncated };
}

export async function searchWorkProjectContent(
  db: AppDatabase,
  projectId: string,
  input: WorkContentSearchRequest,
  signal?: AbortSignal,
): Promise<WorkContentSearchResponse> {
  const query = input.query.trim();
  if (!query) return { files: [], totalMatches: 0, truncated: false };
  if (input.regex) {
    try {
      new RegExp(query, input.caseSensitive ? 'u' : 'iu');
    } catch {
      throw invalid('正则表达式语法无效。');
    }
  }
  const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
  if (project.host_id !== LOCAL_WORK_HOST_ID) {
    throw new AppError(400, 'content_search_local_only', '项目全文查找目前仅支持本机项目。');
  }
  const root = await realpath(resolveLocalTarget(project.directory, homedir(), process.platform)).catch(() => {
    throw invalid('无法访问项目目录。');
  });
  const rgResult = await runRipgrepSearch(root, { ...input, query }, signal);
  if (rgResult !== null) return rgResult;
  return runFallbackNodeSearch(root, { ...input, query }, signal);
}
