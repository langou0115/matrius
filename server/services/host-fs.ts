import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { access, constants as fsConstants, lstat, mkdir, open, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_WORK_HOST_ID,
  WINDOWS_DRIVES_ROOT,
  validateBrowsePath,
  type HostDirectoryListing,
  type HostFilePreview,
  type WorkHostEntry,
  type WorkTerminalLinkResolution,
} from '../../contract/work-projects';
import type { AppDatabase } from '../db/client';
import { fromDbUuid } from '../db/codecs';
import { requireWorkHostRow, type WorkHostRow } from '../db/repositories/hosts';
import { requireWorkProjectRow } from '../db/repositories/projects';
import { AppError, invalid } from '../errors';
import {
  decodeWslText,
  defaultRunCommand,
  ensureWslDistroRunning,
  expandHomePath,
  resolveWslCommand,
  type HostCommandRunner,
  type HostCommandResult,
} from './hosts';

const INSTANCE_ID = 1;
const MAX_ENTRIES = 500;
const BROWSE_TIMEOUT_MS = 10_000;
const LOCAL_FS_CONCURRENCY = 24;
const SYMLINK_STAT_TIMEOUT_MS = 1_000;
const WINDOWS_DRIVES_CACHE_TTL_MS = 10_000;
const FSUTIL_TIMEOUT_MS = 2_500;
const ENTRY_NAME_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

const POSIX_BROWSE_SCRIPT = [
  'raw=$1',
  'target=$raw',
  'if [ -z "$target" ] || [ "$target" = "~" ]; then target=$HOME; fi',
  'case "$target" in "~/"*) target="$HOME/${target#~/}" ;; esac',
  'if [ -z "$raw" ] && { [ -z "$target" ] || [ ! -d "$target" ]; }; then target=/; fi',
  'if [ -z "$target" ]; then target=/; fi',
  'if ! cd -- "$target" 2>/dev/null; then',
  '  if [ -e "$target" ] && [ ! -d "$target" ]; then printf "ERR\\0所选路径不是目录：%s\\0" "$target"; else printf "ERR\\0无法访问目录：%s\\0" "$target"; fi',
  '  exit 2',
  'fi',
  'if command -v python3 >/dev/null 2>&1; then',
  '  python3 -c "',
  'import os, sys',
  'w = sys.stdout.buffer.write',
  'w(b\\"PWD\\\\0\\" + os.fsencode(os.path.realpath(\\".\\")) + b\\"\\\\0\\")',
  'dirs, files = [], []',
  'with os.scandir(\\".\\") as it:',
  '    for e in it:',
  '        try:',
  '            is_dir = e.is_dir(follow_symlinks=True)',
  '        except OSError:',
  '            is_dir = False',
  '        (dirs if is_dir else files).append((e.name, is_dir))',
  'dirs.sort(key=lambda x: x[0].casefold())',
  'selected = dirs[:1500]',
  'if len(selected) < 1500:',
  '    files.sort(key=lambda x: x[0].casefold())',
  '    selected.extend(files[:1500 - len(selected)])',
  'if len(dirs) + len(files) > 1500:',
  '    w(b\\"TRUNC\\\\01\\\\0\\")',
  'for name, is_dir in selected:',
  '    mode = (os.R_OK | os.X_OK) if is_dir else os.R_OK',
  '    ok = os.access(name, mode)',
  '    tag = (b\\"d1\\" if ok else b\\"d0\\") if is_dir else (b\\"f1\\" if ok else b\\"f0\\")',
  '    w(tag + b\\"\\\\0\\" + os.fsencode(name) + b\\"\\\\0\\")',
  '" 2>/dev/null && exit 0',
  'fi',
  'pwd_out=$(pwd -P 2>/dev/null || pwd)',
  'printf "PWD\\0%s\\0" "$pwd_out"',
  'count=0',
  'for entry in .* *; do',
  '  [ "$entry" = "." ] || [ "$entry" = ".." ] && continue',
  '  if [ -d "$entry" ]; then',
  '    if [ -r "$entry" ] && [ -x "$entry" ]; then tag=d1; else tag=d0; fi',
  '  elif [ -e "$entry" ] || [ -L "$entry" ]; then',
  '    if [ -r "$entry" ]; then tag=f1; else tag=f0; fi',
  '  else',
  '    continue',
  '  fi',
  '  count=$((count + 1))',
  '  if [ "$count" -gt 1500 ]; then printf "TRUNC\\01\\0"; break; fi',
  '  printf "%s\\0%s\\0" "$tag" "$entry"',
  'done',
].join('\n');

const MAX_TEXT_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_BINARY_PREVIEW_BYTES = 50 * 1024 * 1024;
const POSIX_PREVIEW_SCRIPT = [
  '[ -f "$1" ] || exit 2',
  `head -c ${MAX_TEXT_PREVIEW_BYTES + 1} < "$1"`,
].join('\n');

function posixBinaryPreviewScript(maxBytes: number): string {
  return [
    '[ -f "$1" ] || exit 2',
    `head -c ${maxBytes + 1} < "$1"`,
  ].join('\n');
}

function decodeFilePreview(bytes: Buffer): HostFilePreview {
  if (bytes.length > MAX_TEXT_PREVIEW_BYTES) {
    throw new AppError(413, 'file_preview_too_large', `文件超过 ${Math.round(MAX_TEXT_PREVIEW_BYTES / (1024 * 1024))} MiB，无法预览。`);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0e-\x1a\x1c-\x1f]/u.test(text)) throw new Error();
    return { text, revision: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    throw new AppError(415, 'file_preview_unsupported', '此文件无法作为 UTF-8 文本预览。');
  }
}

async function readLocalPreviewBytes(path: string, maxBytes?: number): Promise<Buffer> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw invalid('只能预览普通文件。');
    if (maxBytes !== undefined && info.size > maxBytes) {
      const limitLabel = maxBytes >= 1024 * 1024
        ? `${Math.round(maxBytes / (1024 * 1024))} MiB`
        : `${Math.round(maxBytes / 1024)} KiB`;
      throw new AppError(413, 'file_preview_too_large', `文件超过 ${limitLabel}，无法预览。`);
    }
    const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw invalid('只能预览普通文件。');
      if (maxBytes === undefined) {
        return await file.readFile();
      }
      const allocSize = Math.min(maxBytes + 1, Math.max(info.size + 1, 1));
      const bytes = Buffer.alloc(allocSize);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return bytes.subarray(0, offset);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AppError(404, 'path_not_found', '文件不存在。');
    if (code === 'EACCES' || code === 'EPERM') {
      throw new AppError(403, 'path_forbidden', '没有权限读取文件。');
    }
    throw invalid('无法读取文件。');
  }
}

function openPathInSystemExplorer(
  resolvedTarget: string,
  isDir: boolean,
  currentPlatform: NodeJS.Platform,
): void {
  if (currentPlatform === 'win32') {
    const args = isDir ? [resolvedTarget] : [`/select,${resolvedTarget}`];
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return;
  }
  if (currentPlatform === 'darwin') {
    const args = isDir ? [resolvedTarget] : ['-R', resolvedTarget];
    const child = spawn('open', args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return;
  }
  const dirToOpen = isDir ? resolvedTarget : dirname(resolvedTarget);
  const child = spawn('xdg-open', [dirToOpen], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

const POSIX_PROJECT_GIT = [
  'directory=$1',
  'shift',
  'case "$directory" in "~") directory=$HOME ;; "~/"*) directory="$HOME/${directory#~/}" ;; esac',
  'GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true exec git --literal-pathspecs -c core.fsmonitor=false -C "$directory" "$@"',
].join('\n');

export type HostFsService = {
  runProjectGit(hostId: string, directory: string, args: string[]): Promise<HostCommandResult>;
  savePreview(projectId: string, path: string, text: string, baseRevision: string): Promise<HostFilePreview>;
  saveBinaryFile(projectId: string, path: string, bytes: Buffer, baseRevision: string): Promise<{ revision: string }>;
  createEntry(projectId: string, parentPath: string, name: string, kind: 'file' | 'directory'): Promise<WorkHostEntry>;
  renameEntry(projectId: string, path: string, newName: string): Promise<WorkHostEntry>;
  deleteEntry(projectId: string, path: string): Promise<void>;
  revealInSystemExplorer(projectId: string, path?: string): Promise<void>;
  resolveTerminalLink(
    projectId: string,
    rawPath: string,
    options?: { cwd?: string; openDirectoryInExplorer?: boolean },
  ): Promise<WorkTerminalLinkResolution>;
  readPreview(hostId: string, path: string): Promise<HostFilePreview>;
  readBinaryFile(hostId: string, path: string, maxBytes?: number): Promise<Buffer>;
  listEntries(hostId: string, rawPath?: string, options?: { refresh?: boolean }): Promise<HostDirectoryListing>;
};

let cachedAskpassPath: string | null = null;

export function ensureAskpassScript(): string {
  if (cachedAskpassPath && existsSync(cachedAskpassPath)) return cachedAskpassPath;
  if (process.platform === 'win32') {
    const target = join(tmpdir(), 'matrius-ssh-askpass.cmd');
    writeFileSync(target, '@echo off\r\nsetlocal enabledelayedexpansion\r\necho(!MATRIUS_SSH_PASS!\r\n', 'utf8');
    cachedAskpassPath = target;
    return target;
  }
  const target = join(tmpdir(), `matrius-ssh-askpass-${process.getuid?.() ?? 'user'}.sh`);
  writeFileSync(target, '#!/bin/sh\nprintf \'%s\\n\' "$MATRIUS_SSH_PASS"\n', { mode: 0o700 });
  chmodSync(target, 0o700);
  cachedAskpassPath = target;
  return target;
}

export function posixSingleQuote(value: string): string {
  return `'${value.replaceAll('\'', "'\\''")}'`;
}

function sortEntries(entries: WorkHostEntry[]): { entries: WorkHostEntry[]; truncated: boolean } {
  const sorted = [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
    return ENTRY_NAME_COLLATOR.compare(left.name, right.name);
  });
  if (sorted.length > MAX_ENTRIES) {
    return { entries: sorted.slice(0, MAX_ENTRIES), truncated: true };
  }
  return { entries: sorted, truncated: false };
}

const DRIVE_CHECK_TIMEOUT_MS = 400;

export function parseWindowsDrivesOutput(raw: Buffer | string): string[] {
  const text = decodeWslText(raw);
  const matches = text.match(/[A-Za-z]:\\/gu);
  if (!matches) return [];
  const seen = new Set<string>();
  const drives: string[] = [];
  for (const match of matches) {
    const normalized = `${match[0].toUpperCase()}:\\`;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      drives.push(normalized);
    }
  }
  return drives.sort();
}

async function probeWindowsDrivesFallback(): Promise<string[]> {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const checks = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ok = await Promise.race([
          stat(root).then((info) => info.isDirectory()).catch(() => false),
          new Promise<false>((resolveTimeout) => {
            timer = setTimeout(() => resolveTimeout(false), DRIVE_CHECK_TIMEOUT_MS);
          }),
        ]);
        return ok ? root : null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return checks.filter((item): item is string => item !== null);
}

export async function defaultListWindowsDrives(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  // Query logical drives via fsutil.exe (GetLogicalDrives) instead of stat()-ing A:\..Z:\
  // in Node's libuv threadpool, which otherwise stalls all 4 worker threads on disconnected
  // or sleeping network drives.
  const systemRoot = env.SystemRoot || env.WINDIR;
  const primaryCmd = systemRoot ? join(systemRoot, 'System32', 'fsutil.exe') : 'fsutil.exe';
  let result = await defaultRunCommand(primaryCmd, ['fsinfo', 'drives'], { timeoutMs: FSUTIL_TIMEOUT_MS });
  if (result.errorCode === 'ENOENT' && primaryCmd !== 'fsutil.exe') {
    result = await defaultRunCommand('fsutil.exe', ['fsinfo', 'drives'], { timeoutMs: FSUTIL_TIMEOUT_MS });
  }
  if (result.code === 0 && !result.timedOut && !result.errorCode) {
    const drives = parseWindowsDrivesOutput(result.stdout);
    if (drives.length > 0) return drives;
  }
  return probeWindowsDrivesFallback();
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const current = nextIndex;
        nextIndex += 1;
        results[current] = await worker(items[current]);
      }
    }),
  );
  return results;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isWindowsDrivesRequest(rawPath: string, currentPlatform: NodeJS.Platform): boolean {
  if (currentPlatform !== 'win32') return false;
  return rawPath === WINDOWS_DRIVES_ROOT || rawPath === '/' || rawPath === '\\';
}

export function resolveLocalTarget(rawPath: string, homeDir: string, currentPlatform: NodeJS.Platform): string {
  if (!rawPath || rawPath === '~') return homeDir;
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return join(homeDir, rawPath.slice(2));
  if (currentPlatform === 'win32' && /^[A-Za-z]:$/u.test(rawPath)) {
    return `${rawPath.toUpperCase()}\\`;
  }
  return resolve(rawPath);
}

async function listLocalFs(
  hostId: string,
  rawPath: string,
  homeDir: string,
  currentPlatform: NodeJS.Platform,
  listWindowsDrives: (refresh?: boolean) => Promise<string[]>,
  refresh?: boolean,
): Promise<HostDirectoryListing> {
  if (isWindowsDrivesRequest(rawPath, currentPlatform)) {
    const drives = await listWindowsDrives(refresh);
    return {
      hostId,
      path: WINDOWS_DRIVES_ROOT,
      parentPath: null,
      selectable: false,
      truncated: false,
      entries: drives.map((drive) => ({
        kind: 'directory',
        name: drive,
        path: drive,
        accessible: true,
      })),
    };
  }

  const requested = resolveLocalTarget(rawPath, homeDir, currentPlatform);
  let targetPath = requested;
  let dirents;
  try {
    let timedOut = false;
    const result = await withTimeout(
      (async () => {
        const [info, resolved] = await Promise.all([
          stat(requested),
          realpath(requested).catch(() => requested),
        ]);
        if (!info.isDirectory()) {
          throw invalid(`所选路径不是目录：${resolved}`);
        }
        const entries = await readdir(resolved, { withFileTypes: true });
        return { resolved, entries };
      })(),
      BROWSE_TIMEOUT_MS,
      () => {
        timedOut = true;
        return null;
      },
    );
    if (timedOut || !result) {
      throw new AppError(504, 'host_browse_timeout', `读取目录超时：${requested}`);
    }
    targetPath = result.resolved;
    dirents = result.entries;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') throw new AppError(404, 'path_not_found', `目录不存在：${requested}`);
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new AppError(403, 'path_forbidden', `没有权限访问目录：${requested}`);
    throw new AppError(400, 'path_error', `无法读取目录：${err.message}`);
  }

  type PendingEntry = { kind: 'directory' | 'file'; name: string; path: string };
  const dirs: PendingEntry[] = [];
  const files: PendingEntry[] = [];
  const unresolved: typeof dirents = [];

  for (const dirent of dirents) {
    const entryPath = join(targetPath, dirent.name);
    if (dirent.isDirectory()) {
      dirs.push({ kind: 'directory', name: dirent.name, path: entryPath });
    } else if (dirent.isFile()) {
      files.push({ kind: 'file', name: dirent.name, path: entryPath });
    } else {
      unresolved.push(dirent);
    }
  }

  if (unresolved.length > 0) {
    const resolved = await mapWithConcurrency(unresolved, LOCAL_FS_CONCURRENCY, async (dirent): Promise<PendingEntry | null> => {
      const entryPath = join(targetPath, dirent.name);
      if (dirent.isSymbolicLink()) {
        const kind = await withTimeout<'directory' | 'file'>(
          stat(entryPath).then((entryStat) => (entryStat.isDirectory() ? 'directory' : 'file')).catch(() => 'file'),
          SYMLINK_STAT_TIMEOUT_MS,
          () => 'file',
        );
        return { kind, name: dirent.name, path: entryPath };
      }
      const kind = await lstat(entryPath)
        .then((entryStat): 'directory' | 'file' => (entryStat.isDirectory() ? 'directory' : 'file'))
        .catch(() => null);
      return kind ? { kind, name: dirent.name, path: entryPath } : null;
    });
    for (const item of resolved) {
      if (!item) continue;
      if (item.kind === 'directory') dirs.push(item);
      else files.push(item);
    }
  }

  dirs.sort((left, right) => ENTRY_NAME_COLLATOR.compare(left.name, right.name));
  const truncated = dirs.length + files.length > MAX_ENTRIES;
  let selected: PendingEntry[];
  if (dirs.length >= MAX_ENTRIES) {
    selected = dirs.slice(0, MAX_ENTRIES);
  } else {
    files.sort((left, right) => ENTRY_NAME_COLLATOR.compare(left.name, right.name));
    selected = [...dirs, ...files.slice(0, MAX_ENTRIES - dirs.length)];
  }

  const rawEntries: WorkHostEntry[] = await mapWithConcurrency(selected, LOCAL_FS_CONCURRENCY, async (item) => {
    const mode = item.kind === 'directory' ? (fsConstants.R_OK | fsConstants.X_OK) : fsConstants.R_OK;
    const accessible = await access(item.path, mode).then(() => true).catch(() => false);
    return { ...item, accessible };
  });
  const ignoredNames = await detectLocalGitIgnoredNames(targetPath, rawEntries.map((item) => item.name));
  const entries: WorkHostEntry[] = ignoredNames.size > 0
    ? rawEntries.map((item) => (ignoredNames.has(item.name) ? { ...item, ignored: true } : item))
    : rawEntries;

  const parent = dirname(targetPath);
  const parentPath = parent !== targetPath
    ? parent
    : (currentPlatform === 'win32' && /^[A-Za-z]:\\?$/u.test(targetPath) ? WINDOWS_DRIVES_ROOT : null);

  return {
    hostId,
    path: targetPath,
    parentPath,
    truncated,
    entries,
  };
}

export function parsePosixBrowseOutput(hostId: string, stdout: Buffer): HostDirectoryListing {
  const tokens = stdout.toString('utf8').split('\0');
  let resolvedPath = '';
  let truncated = false;
  const rawEntries: WorkHostEntry[] = [];

  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const tag = tokens[index];
    const value = tokens[index + 1];
    if (tag === 'ERR') {
      throw new AppError(400, 'path_error', value || '无法访问目标目录。');
    }
    if (tag === 'PWD') {
      resolvedPath = value;
      continue;
    }
    if (tag === 'TRUNC') {
      truncated = true;
      continue;
    }
    if (tag === 'd' || tag === 'd1' || tag === 'd0' || tag === 'f' || tag === 'f1' || tag === 'f0') {
      if (!value) continue;
      rawEntries.push({
        kind: tag.startsWith('d') ? 'directory' : 'file',
        name: value,
        path: posix.join(resolvedPath || '/', value),
        accessible: !tag.endsWith('0'),
      });
    }
  }

  if (!resolvedPath) {
    throw new AppError(502, 'host_browse_failed', '未能读取目标主机的目录信息。');
  }

  const sorted = sortEntries(rawEntries);
  const parent = resolvedPath === '/' ? null : posix.dirname(resolvedPath);
  return {
    hostId,
    path: resolvedPath,
    parentPath: parent,
    truncated: truncated || sorted.truncated,
    entries: sorted.entries,
  };
}

async function detectLocalGitIgnoredNames(cwd: string, names: readonly string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  return new Promise((resolveSet) => {
    let settled = false;
    const finish = (result: Set<string>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveSet(result);
    };
    const child = spawn('git', ['check-ignore', '--stdin', '-z'], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      finish(new Set());
    }, 1200);
    child.on('error', () => finish(new Set()));
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Set());
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const ignored = new Set<string>();
      for (const token of raw.split('\0')) {
        if (!token) continue;
        const cleaned = token.replace(/^\.[\\/]/u, '').replace(/[\\/]+$/u, '');
        if (cleaned) ignored.add(cleaned);
      }
      finish(ignored);
    });
    try {
      child.stdin.end(Buffer.from(`${names.join('\0')}\0`, 'utf8'));
    } catch {
      finish(new Set());
    }
  });
}

function summarizeBrowseFailure(stderr: Buffer, fallback: string): string {
  const line = decodeWslText(stderr)
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 220 ? `${line.slice(0, 220)}…` : line;
}

export function createHostFsService(options: {
  db: AppDatabase;
  runCommand?: HostCommandRunner;
  wslCommand?: string | null;
  currentPlatform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  listWindowsDrives?: () => Promise<string[]>;
  runtimeHostSecrets?: Map<string, string>;
}): HostFsService {
  const { db } = options;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const currentPlatform = options.currentPlatform ?? process.platform;
  const env = options.env ?? process.env;
  const wslCommand = options.wslCommand !== undefined ? options.wslCommand : resolveWslCommand(currentPlatform);
  const homeDir = options.homeDir ?? homedir();
  const customListWindowsDrives = options.listWindowsDrives;
  let cachedDrives: { items: string[]; expiresAt: number } | null = null;
  let pendingDrives: Promise<string[]> | null = null;
  const listWindowsDrives = async (refresh = false): Promise<string[]> => {
    if (customListWindowsDrives) return customListWindowsDrives();
    const now = Date.now();
    if (!refresh && cachedDrives && cachedDrives.expiresAt > now) {
      return cachedDrives.items;
    }
    if (refresh) {
      cachedDrives = null;
    } else if (pendingDrives) {
      return pendingDrives;
    }
    const request = defaultListWindowsDrives(env)
      .then((items) => {
        cachedDrives = { items, expiresAt: Date.now() + WINDOWS_DRIVES_CACHE_TTL_MS };
        return items;
      })
      .finally(() => {
        if (pendingDrives === request) pendingDrives = null;
      });
    pendingDrives = request;
    return request;
  };
  const runtimeHostSecrets = options.runtimeHostSecrets ?? new Map<string, string>();

  const POSIX_SAVE_FILE_SCRIPT = [
    'root_raw=$1',
    'target_raw=$2',
    'base_rev=$3',
    'case "$root_raw" in "~") root_raw=$HOME ;; "~/"*) root_raw="$HOME/${root_raw#~/}" ;; esac',
    'if command -v python3 >/dev/null 2>&1; then',
    '  python3 -c \'',
    'import hashlib, os, sys, tempfile',
    'root_raw, target_raw, base_rev = sys.argv[1], sys.argv[2], sys.argv[3]',
    'if not os.path.isfile(target_raw): sys.exit(2)',
    'root = os.path.realpath(root_raw)',
    'target = os.path.realpath(target_raw)',
    'try:',
    '    rel = os.path.relpath(target, root)',
    'except ValueError:',
    '    sys.exit(4)',
    'if rel in (".", "..") or rel.startswith(".." + os.sep) or os.path.isabs(rel):',
    '    sys.exit(4)',
    'try:',
    '    with open(target, "rb") as f:',
    '        original = f.read()',
    'except PermissionError:',
    '    sys.exit(5)',
    'current_rev = hashlib.sha256(original).hexdigest()',
    'if current_rev != base_rev: sys.exit(3)',
    'bom = b"\\xef\\xbb\\xbf" if original.startswith(b"\\xef\\xbb\\xbf") else b""',
    'new_text = sys.stdin.buffer.read()',
    'replacement = bom + new_text',
    'next_rev = hashlib.sha256(replacement).hexdigest()',
    'if next_rev == current_rev:',
    '    sys.stdout.write(next_rev)',
    '    sys.exit(0)',
    'if not os.access(target, os.W_OK): sys.exit(5)',
    'mode = os.stat(target).st_mode & 0o777',
    'tmp_path = None',
    'try:',
    '    fd, tmp_path = tempfile.mkstemp(prefix=".matrius-save-", suffix=".tmp", dir=os.path.dirname(target))',
    '    try:',
    '        os.write(fd, replacement)',
    '        os.chmod(fd, mode)',
    '        os.fsync(fd)',
    '    finally:',
    '        os.close(fd)',
    '    with open(target, "rb") as f:',
    '        if hashlib.sha256(f.read()).hexdigest() != base_rev: sys.exit(3)',
    '    os.replace(tmp_path, target)',
    '    tmp_path = None',
    '    sys.stdout.write(next_rev)',
    'except PermissionError:',
    '    sys.exit(5)',
    'finally:',
    '    if tmp_path and os.path.exists(tmp_path):',
    '        try: os.unlink(tmp_path)',
    '        except OSError: pass',
    '\' "$root_raw" "$target_raw" "$base_rev"',
    '  exit $?',
    'fi',
    '[ -f "$target_raw" ] || exit 2',
    'root=$(cd -- "$root_raw" 2>/dev/null && pwd -P) || exit 2',
    'target_dir=$(cd -- "$(dirname -- "$target_raw")" 2>/dev/null && pwd -P) || exit 2',
    'target="$target_dir/$(basename -- "$target_raw")"',
    'case "$target" in "$root"/*) ;; *) exit 4 ;; esac',
    '[ -w "$target" ] || exit 5',
    'sha_cmd=""',
    'if command -v sha256sum >/dev/null 2>&1; then sha_cmd="sha256sum"; elif command -v shasum >/dev/null 2>&1; then sha_cmd="shasum -a 256"; else exit 1; fi',
    'cur_rev=$($sha_cmd < "$target" | awk "{print \\$1}")',
    '[ "$cur_rev" = "$base_rev" ] || exit 3',
    'tmp=$(mktemp "$target_dir/.matrius-save-XXXXXX") || exit 5',
    'cat > "$tmp" || { rm -f "$tmp"; exit 5; }',
    'next_rev=$($sha_cmd < "$tmp" | awk "{print \\$1}")',
    'if [ "$next_rev" = "$cur_rev" ]; then rm -f "$tmp"; printf "%s" "$next_rev"; exit 0; fi',
    'chmod --reference="$target" "$tmp" 2>/dev/null || true',
    'mv -f "$tmp" "$target" || { rm -f "$tmp"; exit 5; }',
    'printf "%s" "$next_rev"',
  ].join('\n');

  async function runWslFs(
    row: WorkHostRow,
    rawPath: string,
    script: string,
    scriptArgs: string[] = [],
    timeoutMs = BROWSE_TIMEOUT_MS,
    extra: { input?: Buffer | string; maxBuffer?: number } = {},
  ) {
    if (!wslCommand) {
      throw new AppError(400, 'wsl_unavailable', '当前运行环境无法浏览该 WSL 发行版目录。');
    }

    const runningCheck = await ensureWslDistroRunning(wslCommand, row.distro, runCommand);
    if (!runningCheck.ok) {
      if (runningCheck.code === 'enoent') throw new AppError(400, 'wsl_unavailable', runningCheck.message);
      if (runningCheck.code === 'timed_out') throw new AppError(504, 'host_browse_timeout', runningCheck.message);
      throw new AppError(502, 'host_browse_failed', runningCheck.message);
    }

    const args = ['-d', row.distro];
    if (row.username) args.push('--user', row.username);
    args.push('--exec', 'sh', '-c', script, '_', rawPath, ...scriptArgs);

    const result = await runCommand(wslCommand, args, {
      timeoutMs,
      env: { WSL_UTF8: '1' },
      ...extra,
    });

    if (result.errorCode === 'ENOENT') {
      throw new AppError(400, 'wsl_unavailable', '未找到 wsl.exe，无法浏览 WSL 发行版目录。');
    }
    if (result.timedOut) {
      throw new AppError(504, 'host_browse_timeout', `读取 WSL 发行版 ${row.distro} 目录超时。`);
    }
    return result;
  }

  async function runSshFs(
    row: WorkHostRow,
    rawPath: string,
    script: string,
    scriptArgs: string[] = [],
    timeoutMs = BROWSE_TIMEOUT_MS,
    extra: { input?: Buffer | string; maxBuffer?: number } = {},
  ) {
    const resolvedSecret = runtimeHostSecrets.get(fromDbUuid(row.id)) || row.secret_value;
    if (row.auth_method === 'password' && !resolvedSecret) {
      throw new AppError(401, 'ssh_auth_required', '未保存 SSH 密码，请输入密码以浏览工作目录。');
    }

    const args = [
      '-T',
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(row.port),
    ];

    const cmdEnv: Record<string, string> = {};
    if (row.auth_method === 'key' && row.private_key_path) {
      args.push('-i', expandHomePath(row.private_key_path), '-o', 'IdentitiesOnly=yes');
    }
    if (resolvedSecret) {
      args.push('-o', 'NumberOfPasswordPrompts=1');
      cmdEnv.SSH_ASKPASS = ensureAskpassScript();
      cmdEnv.SSH_ASKPASS_REQUIRE = 'force';
      cmdEnv.DISPLAY = env.DISPLAY || 'matrius:0';
      cmdEnv.MATRIUS_SSH_PASS = resolvedSecret;
    } else {
      args.push('-o', 'BatchMode=yes');
    }

    const target = row.username ? `${row.username}@${row.host}` : row.host;
    const remoteCommand = `sh -c ${posixSingleQuote(script)} _ ${[rawPath, ...scriptArgs].map(posixSingleQuote).join(' ')}`;
    args.push('--', target, remoteCommand);

    const result = await runCommand('ssh', args, {
      timeoutMs,
      env: cmdEnv,
      ...extra,
    });

    if (result.errorCode === 'ENOENT') {
      throw new AppError(400, 'ssh_unavailable', '本机未找到 ssh 客户端，请先安装 OpenSSH Client。');
    }
    if (result.timedOut) {
      throw new AppError(504, 'host_browse_timeout', `读取远程主机 ${row.name} 目录超时。`);
    }
    return result;
  }

  function runRemoteFs(
    row: WorkHostRow,
    path: string,
    script: string,
    scriptArgs?: string[],
    timeoutMs?: number,
    extra?: { input?: Buffer | string; maxBuffer?: number },
  ) {
    return row.kind === 'wsl'
      ? runWslFs(row, path, script, scriptArgs, timeoutMs, extra)
      : runSshFs(row, path, script, scriptArgs, timeoutMs, extra);
  }

  const savingPaths = new Set<string>();
  function assertRevision(bytes: Buffer, expected: string): HostFilePreview {
    const current = decodeFilePreview(bytes);
    if (current.revision !== expected) {
      throw new AppError(409, 'file_preview_conflict', '文件已在其他地方修改。请先复制当前草稿，再重新打开文件。');
    }
    return current;
  }

  return {
    async runProjectGit(hostId, directory, args) {
      const isLongOp = args.some((arg) => arg === 'fetch' || arg === 'pull' || arg === 'push' || arg === 'commit');
      const timeoutMs = isLongOp ? 30_000 : BROWSE_TIMEOUT_MS;
      if (hostId === LOCAL_WORK_HOST_ID) {
        const target = resolveLocalTarget(directory, homeDir, currentPlatform);
        return runCommand('git', ['--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', target, ...args], {
          timeoutMs,
          env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
        });
      }
      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      return runRemoteFs(row, directory, POSIX_PROJECT_GIT, args, timeoutMs);
    },

    async savePreview(projectId, path, text, baseRevision) {
      const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
      if (project.host_id !== LOCAL_WORK_HOST_ID) {
        if (!posix.isAbsolute(path) || path.includes('\0')) {
          throw invalid('文件路径不合法。');
        }
        const replacement = Buffer.from(text, 'utf8');
        decodeFilePreview(replacement);
        const lockKey = `${project.host_id}:${path}`;
        if (savingPaths.has(lockKey)) throw new AppError(409, 'file_preview_busy', '文件正在保存，请稍后重试。');
        savingPaths.add(lockKey);
        try {
          const row = requireWorkHostRow(db, INSTANCE_ID, project.host_id);
          const result = await runRemoteFs(
            row,
            project.directory,
            POSIX_SAVE_FILE_SCRIPT,
            [path, baseRevision],
            20_000,
            { input: replacement },
          );
          if (result.code === 2) throw invalid('文件不存在或不是普通文件。');
          if (result.code === 3) {
            throw new AppError(409, 'file_preview_conflict', '文件已在其他地方修改。请先复制当前草稿，再重新打开文件。');
          }
          if (result.code === 4) {
            throw new AppError(403, 'path_forbidden', '只能编辑项目目录中的普通文件。');
          }
          if (result.code === 5) {
            throw new AppError(403, 'path_forbidden', '没有权限写入远程文件。');
          }
          if (result.code === 6) {
            throw new AppError(413, 'file_preview_too_large', '文件超过大小限制，无法保存。');
          }
          if (result.code !== 0) {
            throw new AppError(502, 'host_save_failed', summarizeBrowseFailure(result.stderr, '保存远程文件失败。'));
          }
          const nextRevision = result.stdout.toString('utf8').trim();
          const revision = /^[a-f0-9]{64}$/u.test(nextRevision)
            ? nextRevision
            : createHash('sha256').update(replacement).digest('hex');
          return { text, revision };
        } finally {
          savingPaths.delete(lockKey);
        }
      }
      if (!isAbsolute(path) || path.includes('\0') || (currentPlatform === 'win32' && !/^[a-z]:[\\/][^:]*$/iu.test(path))) {
        throw invalid('文件路径不合法。');
      }
      const [root, target] = await Promise.all([
        realpath(resolveLocalTarget(project.directory, homeDir, currentPlatform)),
        realpath(path),
      ]).catch(() => { throw invalid('无法访问项目目录或文件。'); });
      const within = relative(root, target);
      if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + sep)) {
        throw new AppError(403, 'path_forbidden', '只能编辑项目目录中的普通文件。');
      }

      const lockPath = currentPlatform === 'win32' ? target.toLowerCase() : target;
      if (savingPaths.has(lockPath)) throw new AppError(409, 'file_preview_busy', '文件正在保存，请稍后重试。');
      savingPaths.add(lockPath);
      const tempPath = join(dirname(target), `.matrius-save-${randomUUID()}.tmp`);
      let tempCreated = false;
      try {
        const original = await readLocalPreviewBytes(target);
        const current = assertRevision(original, baseRevision);
        const bom = original.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
        const replacement = Buffer.from((bom ? '\uFEFF' : '') + text, 'utf8');
        const saved = decodeFilePreview(replacement);
        if (current.revision === saved.revision) return current;
        await access(target, fsConstants.W_OK);
        const { mode } = await stat(target);
        const temp = await open(tempPath, 'wx', 0o600);
        tempCreated = true;
        try {
          await temp.writeFile(replacement);
          await temp.chmod(mode & 0o777);
          await temp.sync();
        } finally {
          await temp.close();
        }
        assertRevision(await readLocalPreviewBytes(target), baseRevision);
        await rename(tempPath, target);
        tempCreated = false;
        return saved;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw invalid('保存文件失败，请检查文件与目录权限。');
      } finally {
        savingPaths.delete(lockPath);
        if (tempCreated) await unlink(tempPath).catch(() => {});
      }
    },

    async saveBinaryFile(projectId, path, replacement, baseRevision) {
      if (replacement.length > MAX_BINARY_PREVIEW_BYTES) {
        throw new AppError(413, 'file_preview_too_large', `文件超过 ${Math.round(MAX_BINARY_PREVIEW_BYTES / (1024 * 1024))} MiB，无法保存。`);
      }
      const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
      if (project.host_id !== LOCAL_WORK_HOST_ID) {
        if (!posix.isAbsolute(path) || path.includes('\0')) {
          throw invalid('文件路径不合法。');
        }
        const lockKey = `${project.host_id}:${path}`;
        if (savingPaths.has(lockKey)) throw new AppError(409, 'file_preview_busy', '文件正在保存，请稍后重试。');
        savingPaths.add(lockKey);
        const binaryScript = POSIX_SAVE_FILE_SCRIPT
          .replace('bom = b"\\xef\\xbb\\xbf" if original.startswith(b"\\xef\\xbb\\xbf") else b""', 'bom = b""');
        try {
          const row = requireWorkHostRow(db, INSTANCE_ID, project.host_id);
          const result = await runRemoteFs(
            row,
            project.directory,
            binaryScript,
            [path, baseRevision],
            30_000,
            { input: replacement },
          );
          if (result.code === 2) throw invalid('文件不存在或不是普通文件。');
          if (result.code === 3) {
            throw new AppError(409, 'file_preview_conflict', '文件已在其他地方修改，请重新打开文件后再编辑。');
          }
          if (result.code === 4) {
            throw new AppError(403, 'path_forbidden', '只能编辑项目目录中的普通文件。');
          }
          if (result.code === 5) {
            throw new AppError(403, 'path_forbidden', '没有权限写入远程文件。');
          }
          if (result.code === 6) {
            throw new AppError(413, 'file_preview_too_large', '文件超过大小限制，无法保存。');
          }
          if (result.code !== 0) {
            throw new AppError(502, 'host_save_failed', summarizeBrowseFailure(result.stderr, '保存远程文件失败。'));
          }
          const nextRevision = result.stdout.toString('utf8').trim();
          const revision = /^[a-f0-9]{64}$/u.test(nextRevision)
            ? nextRevision
            : createHash('sha256').update(replacement).digest('hex');
          return { revision };
        } finally {
          savingPaths.delete(lockKey);
        }
      }
      if (!isAbsolute(path) || path.includes('\0') || (currentPlatform === 'win32' && !/^[a-z]:[\\/][^:]*$/iu.test(path))) {
        throw invalid('文件路径不合法。');
      }
      const [root, target] = await Promise.all([
        realpath(resolveLocalTarget(project.directory, homeDir, currentPlatform)),
        realpath(path),
      ]).catch(() => { throw invalid('无法访问项目目录或文件。'); });
      const within = relative(root, target);
      if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + sep)) {
        throw new AppError(403, 'path_forbidden', '只能编辑项目目录中的普通文件。');
      }

      const lockPath = currentPlatform === 'win32' ? target.toLowerCase() : target;
      if (savingPaths.has(lockPath)) throw new AppError(409, 'file_preview_busy', '文件正在保存，请稍后重试。');
      savingPaths.add(lockPath);
      const tempPath = join(dirname(target), `.matrius-save-${randomUUID()}.tmp`);
      let tempCreated = false;
      try {
        const original = await readLocalPreviewBytes(target, MAX_BINARY_PREVIEW_BYTES);
        const currentRev = createHash('sha256').update(original).digest('hex');
        if (currentRev !== baseRevision) {
          throw new AppError(409, 'file_preview_conflict', '文件已在其他地方修改，请重新打开文件后再编辑。');
        }
        const nextRev = createHash('sha256').update(replacement).digest('hex');
        if (nextRev === currentRev) return { revision: currentRev };
        await access(target, fsConstants.W_OK);
        const { mode } = await stat(target);
        const temp = await open(tempPath, 'wx', 0o600);
        tempCreated = true;
        try {
          await temp.writeFile(replacement);
          await temp.chmod(mode & 0o777);
          await temp.sync();
        } finally {
          await temp.close();
        }
        const verifyRev = createHash('sha256').update(await readLocalPreviewBytes(target, MAX_BINARY_PREVIEW_BYTES)).digest('hex');
        if (verifyRev !== baseRevision) {
          throw new AppError(409, 'file_preview_conflict', '文件已在其他地方修改，请重新打开文件后再编辑。');
        }
        await rename(tempPath, target);
        tempCreated = false;
        return { revision: nextRev };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw invalid('保存文件失败，请检查文件与目录权限。');
      } finally {
        savingPaths.delete(lockPath);
        if (tempCreated) await unlink(tempPath).catch(() => {});
      }
    },

    async createEntry(projectId, parentPath, rawName, kind) {
      const name = rawName.trim();
      if (!name || name === '.' || name === '..' || /[\\/\0]/u.test(name)) {
        throw invalid('名称不合法，不能包含路径分隔符。');
      }
      const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
      if (project.host_id !== LOCAL_WORK_HOST_ID) {
        const dirPath = parentPath || project.directory;
        if (!posix.isAbsolute(dirPath) || dirPath.includes('\0')) throw invalid('目录路径不合法。');
        const row = requireWorkHostRow(db, INSTANCE_ID, project.host_id);
        const script = [
          'root=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1")',
          'parent=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$2")',
          'case "$parent" in "$root"|"$root"/*) ;; *) exit 4 ;; esac',
          'target="$parent/$3"',
          'if [ -e "$target" ]; then exit 3; fi',
          'if [ "$4" = "directory" ]; then mkdir -- "$target"; else : > "$target"; fi',
          'printf "%s" "$target"',
        ].join('\n');
        const result = await runRemoteFs(row, project.directory, script, [dirPath, name, kind], 15_000);
        if (result.code === 3) throw new AppError(409, 'entry_exists', '目标名称已存在。');
        if (result.code === 4) throw new AppError(403, 'path_forbidden', '只能在项目目录内新建文件或文件夹。');
        if (result.code !== 0) throw new AppError(502, 'host_fs_failed', summarizeBrowseFailure(result.stderr, '新建失败。'));
        const createdPath = result.stdout.toString('utf8').trim() || posix.join(dirPath, name);
        return { kind, name, path: createdPath, accessible: true };
      }
      const root = await realpath(resolveLocalTarget(project.directory, homeDir, currentPlatform)).catch(() => {
        throw invalid('无法访问项目目录。');
      });
      const resolvedParent = await realpath(parentPath ? resolveLocalTarget(parentPath, homeDir, currentPlatform) : root).catch(() => {
        throw invalid('目标目录不存在。');
      });
      const relParent = relative(root, resolvedParent);
      if (isAbsolute(relParent) || relParent === '..' || relParent.startsWith('..' + sep)) {
        throw new AppError(403, 'path_forbidden', '只能在项目目录内新建文件或文件夹。');
      }
      const target = join(resolvedParent, name);
      if (existsSync(target)) {
        throw new AppError(409, 'entry_exists', '目标名称已存在。');
      }
      try {
        if (kind === 'directory') {
          await mkdir(target);
        } else {
          const handle = await open(target, 'wx');
          await handle.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
          throw new AppError(409, 'entry_exists', '目标名称已存在。');
        }
        throw invalid('新建失败，请检查目录权限。');
      }
      return { kind, name, path: target, accessible: true };
    },

    async renameEntry(projectId, targetPath, rawNewName) {
      const newName = rawNewName.trim();
      if (!newName || newName === '.' || newName === '..' || /[\\/\0]/u.test(newName)) {
        throw invalid('名称不合法，不能包含路径分隔符。');
      }
      const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
      if (project.host_id !== LOCAL_WORK_HOST_ID) {
        if (!posix.isAbsolute(targetPath) || targetPath.includes('\0')) throw invalid('文件路径不合法。');
        const row = requireWorkHostRow(db, INSTANCE_ID, project.host_id);
        const script = [
          'root=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1")',
          'target=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$2")',
          'case "$target" in "$root"/*) ;; *) exit 4 ;; esac',
          'parent=$(dirname -- "$target")',
          'dest="$parent/$3"',
          'if [ "$dest" != "$target" ] && [ -e "$dest" ]; then exit 3; fi',
          'if [ -d "$target" ]; then kind="directory"; else kind="file"; fi',
          'mv -- "$target" "$dest"',
          'printf "%s\\0%s" "$kind" "$dest"',
        ].join('\n');
        const result = await runRemoteFs(row, project.directory, script, [targetPath, newName], 15_000);
        if (result.code === 3) throw new AppError(409, 'entry_exists', '目标名称已存在。');
        if (result.code === 4) throw new AppError(403, 'path_forbidden', '只能重命名项目目录内的文件或文件夹。');
        if (result.code !== 0) throw new AppError(502, 'host_fs_failed', summarizeBrowseFailure(result.stderr, '重命名失败。'));
        const [kindRaw, destPath] = result.stdout.toString('utf8').split('\0');
        return {
          kind: kindRaw === 'directory' ? 'directory' : 'file',
          name: newName,
          path: destPath || posix.join(posix.dirname(targetPath), newName),
          accessible: true,
        };
      }
      const [root, resolvedTarget] = await Promise.all([
        realpath(resolveLocalTarget(project.directory, homeDir, currentPlatform)),
        realpath(targetPath),
      ]).catch(() => { throw invalid('无法访问项目目录或目标路径。'); });
      const rel = relative(root, resolvedTarget);
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
        throw new AppError(403, 'path_forbidden', '只能重命名项目目录内的文件或文件夹。');
      }
      const info = await lstat(resolvedTarget);
      const kind: 'file' | 'directory' = info.isDirectory() ? 'directory' : 'file';
      const dest = join(dirname(resolvedTarget), newName);
      const samePath = currentPlatform === 'win32'
        ? dest.toLowerCase() === resolvedTarget.toLowerCase()
        : dest === resolvedTarget;
      if (!samePath && existsSync(dest)) {
        throw new AppError(409, 'entry_exists', '目标名称已存在。');
      }
      try {
        await rename(resolvedTarget, dest);
      } catch {
        throw invalid('重命名失败，请检查文件是否被占用或权限不足。');
      }
      return { kind, name: newName, path: dest, accessible: true };
    },

    async deleteEntry(projectId, targetPath) {
      const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
      if (project.host_id !== LOCAL_WORK_HOST_ID) {
        if (!posix.isAbsolute(targetPath) || targetPath.includes('\0')) throw invalid('文件路径不合法。');
        const row = requireWorkHostRow(db, INSTANCE_ID, project.host_id);
        const script = [
          'root=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$1")',
          'target=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$2")',
          'case "$target" in "$root"/*) ;; *) exit 4 ;; esac',
          'rm -rf -- "$target"',
        ].join('\n');
        const result = await runRemoteFs(row, project.directory, script, [targetPath], 15_000);
        if (result.code === 4) throw new AppError(403, 'path_forbidden', '只能删除项目目录内的文件或文件夹。');
        if (result.code !== 0) throw new AppError(502, 'host_fs_failed', summarizeBrowseFailure(result.stderr, '删除失败。'));
        return;
      }
      const [root, resolvedTarget] = await Promise.all([
        realpath(resolveLocalTarget(project.directory, homeDir, currentPlatform)),
        realpath(targetPath),
      ]).catch(() => { throw invalid('无法访问项目目录或目标路径。'); });
      const rel = relative(root, resolvedTarget);
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
        throw new AppError(403, 'path_forbidden', '只能删除项目目录内的文件或文件夹。');
      }
      try {
        await rm(resolvedTarget, { recursive: true, force: false });
      } catch {
        throw invalid('删除失败，请检查文件是否被占用或权限不足。');
      }
    },

    async revealInSystemExplorer(projectId, targetPath) {
      const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
      if (project.host_id !== LOCAL_WORK_HOST_ID) {
        throw new AppError(400, 'reveal_local_only', '仅支持在本机项目中打开系统资源管理器。');
      }
      const root = await realpath(resolveLocalTarget(project.directory, homeDir, currentPlatform)).catch(() => {
        throw invalid('无法访问项目目录。');
      });
      const resolvedTarget = targetPath
        ? await realpath(resolveLocalTarget(targetPath, homeDir, currentPlatform)).catch(() => {
            throw invalid('目标路径不存在。');
          })
        : root;
      const rel = relative(root, resolvedTarget);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
        throw new AppError(403, 'path_forbidden', '只能打开项目目录内的文件或文件夹。');
      }
      const info = await lstat(resolvedTarget);
      openPathInSystemExplorer(resolvedTarget, info.isDirectory(), currentPlatform);
    },

    async resolveTerminalLink(projectId, rawInput, linkOptions) {
      const openDirectoryInExplorer = linkOptions?.openDirectoryInExplorer !== false;
      const trimmed = rawInput.trim().replace(/^['"`]|['"`]$/gu, '');
      if (!trimmed || trimmed.includes('\0') || trimmed.length > 1000) {
        return { kind: 'not_found' };
      }
      const project = requireWorkProjectRow(db, INSTANCE_ID, projectId);
      const cwd = linkOptions?.cwd?.trim() || undefined;

      if (project.host_id === LOCAL_WORK_HOST_ID) {
        let normalizedInput = trimmed;
        if (/^file:\/\//iu.test(normalizedInput)) {
          try {
            normalizedInput = fileURLToPath(normalizedInput);
          } catch {
            return { kind: 'not_found' };
          }
        }
        const candidates: string[] = [];
        const seen = new Set<string>();
        const pushCandidate = (value: string) => {
          const key = currentPlatform === 'win32' ? value.toLowerCase() : value;
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push(value);
          }
        };
        const isExplicitAbsolute = normalizedInput === '~'
          || normalizedInput.startsWith('~/')
          || normalizedInput.startsWith('~\\')
          || isAbsolute(normalizedInput)
          || (currentPlatform === 'win32' && /^[A-Za-z]:(?:[\\/]|$)/u.test(normalizedInput));
        if (isExplicitAbsolute) {
          pushCandidate(resolveLocalTarget(normalizedInput, homeDir, currentPlatform));
        } else {
          if (cwd) {
            pushCandidate(resolve(resolveLocalTarget(cwd, homeDir, currentPlatform), normalizedInput));
          }
          pushCandidate(resolve(resolveLocalTarget(project.directory, homeDir, currentPlatform), normalizedInput));
        }

        const root = await realpath(resolveLocalTarget(project.directory, homeDir, currentPlatform))
          .catch(() => resolveLocalTarget(project.directory, homeDir, currentPlatform));

        for (const candidate of candidates) {
          let info;
          try {
            info = await stat(candidate);
          } catch {
            continue;
          }
          const resolvedTarget = await realpath(candidate).catch(() => candidate);
          if (info.isDirectory()) {
            if (openDirectoryInExplorer) {
              openPathInSystemExplorer(resolvedTarget, true, currentPlatform);
            }
            return { kind: 'directory', path: resolvedTarget, openedInExplorer: openDirectoryInExplorer };
          }
          if (info.isFile()) {
            const rel = relative(root, resolvedTarget);
            const outsideProject = isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep);
            return {
              kind: 'file',
              path: resolvedTarget,
              name: basename(resolvedTarget),
              outsideProject,
            };
          }
        }
        return { kind: 'not_found' };
      }

      let remoteInput = trimmed;
      if (/^file:\/\//iu.test(remoteInput)) {
        try {
          remoteInput = decodeURIComponent(new URL(remoteInput).pathname);
        } catch {
          return { kind: 'not_found' };
        }
      }
      const row = requireWorkHostRow(db, INSTANCE_ID, project.host_id);
      const resolveScript = [
        'raw=$1',
        'cwd_dir=$2',
        'proj_dir=$3',
        'expand_home() { case "$1" in "~") printf "%s" "$HOME" ;; "~/"*) printf "%s" "$HOME/${1#~/}" ;; *) printf "%s" "$1" ;; esac; }',
        'raw=$(expand_home "$raw")',
        'cwd_dir=$(expand_home "$cwd_dir")',
        'proj_dir=$(expand_home "$proj_dir")',
        'check_path() {',
        '  p=$1',
        '  [ -n "$p" ] || return 1',
        '  if [ -d "$p" ]; then',
        '    rp=$(cd -- "$p" 2>/dev/null && pwd -P) || rp=$p',
        '    printf "d\\0%s\\0" "$rp"',
        '    return 0',
        '  fi',
        '  if [ -f "$p" ]; then',
        '    dir=$(cd -- "$(dirname -- "$p")" 2>/dev/null && pwd -P) || dir=$(dirname -- "$p")',
        '    rp="$dir/$(basename -- "$p")"',
        '    root=$(cd -- "$proj_dir" 2>/dev/null && pwd -P) || root=$proj_dir',
        '    case "$rp" in "$root"/*) in_proj=1 ;; *) in_proj=0 ;; esac',
        '    printf "f\\0%s\\0%s\\0" "$rp" "$in_proj"',
        '    return 0',
        '  fi',
        '  return 1',
        '}',
        'case "$raw" in',
        '  /*) check_path "$raw" && exit 0 ;;',
        '  *)',
        '    if [ -n "$cwd_dir" ]; then check_path "$cwd_dir/$raw" && exit 0; fi',
        '    if [ -n "$proj_dir" ]; then check_path "$proj_dir/$raw" && exit 0; fi',
        '    ;;',
        'esac',
        'exit 2',
      ].join('\n');

      const result = await runRemoteFs(row, remoteInput, resolveScript, [cwd ?? '', project.directory], 10_000);
      if (result.code !== 0) {
        return { kind: 'not_found' };
      }
      const tokens = result.stdout.toString('utf8').split('\0');
      const kindTag = tokens[0];
      const resolvedPath = tokens[1];
      if (!resolvedPath) return { kind: 'not_found' };
      if (kindTag === 'd') {
        let openedInExplorer = false;
        if (row.kind === 'wsl' && currentPlatform === 'win32' && openDirectoryInExplorer && wslCommand) {
          const wslPathRes = await runCommand(wslCommand, ['-d', row.distro, '--exec', 'wslpath', '-w', resolvedPath], {
            timeoutMs: 5_000,
            env: { WSL_UTF8: '1' },
          }).catch(() => null);
          const winPath = wslPathRes && wslPathRes.code === 0 ? decodeWslText(wslPathRes.stdout).trim() : '';
          if (winPath) {
            openPathInSystemExplorer(winPath, true, currentPlatform);
            openedInExplorer = true;
          }
        }
        return { kind: 'directory', path: resolvedPath, openedInExplorer };
      }
      if (kindTag === 'f') {
        return {
          kind: 'file',
          path: resolvedPath,
          name: posix.basename(resolvedPath),
          outsideProject: tokens[2] !== '1',
        };
      }
      return { kind: 'not_found' };
    },

    async readPreview(hostId, path) {
      try {
        validateBrowsePath(path);
        if (path.includes('\0')) throw new Error();
      } catch {
        throw invalid('文件路径不合法。');
      }
      if (hostId === LOCAL_WORK_HOST_ID) {
        if (!isAbsolute(path) || (currentPlatform === 'win32' && !/^[a-z]:[\\/][^:]*$/iu.test(path))) {
          throw invalid('文件路径不合法。');
        }
        return decodeFilePreview(await readLocalPreviewBytes(path, MAX_TEXT_PREVIEW_BYTES));
      }
      if (!posix.isAbsolute(path)) throw invalid('文件路径不合法。');
      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      const result = await runRemoteFs(row, path, POSIX_PREVIEW_SCRIPT, [], 20_000, {
        maxBuffer: MAX_TEXT_PREVIEW_BYTES + 64 * 1024,
      });
      if (result.code === 2) throw invalid('文件不存在或不是普通文件。');
      if (result.code !== 0) {
        throw new AppError(502, 'host_preview_failed', summarizeBrowseFailure(result.stderr, '无法读取主机文件。'));
      }
      return decodeFilePreview(result.stdout);
    },

    async readBinaryFile(hostId, path, maxBytes = MAX_BINARY_PREVIEW_BYTES) {
      try {
        validateBrowsePath(path);
        if (path.includes('\0')) throw new Error();
      } catch {
        throw invalid('文件路径不合法。');
      }
      if (hostId === LOCAL_WORK_HOST_ID) {
        if (!isAbsolute(path) || (currentPlatform === 'win32' && !/^[a-z]:[\\/][^:]*$/iu.test(path))) {
          throw invalid('文件路径不合法。');
        }
        const bytes = await readLocalPreviewBytes(path, maxBytes);
        if (bytes.length > maxBytes) {
          throw new AppError(413, 'file_preview_too_large', `文件超过 ${Math.round(maxBytes / (1024 * 1024))} MiB，无法预览。`);
        }
        return bytes;
      }
      if (!posix.isAbsolute(path)) throw invalid('文件路径不合法。');
      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      const result = await runRemoteFs(row, path, posixBinaryPreviewScript(maxBytes), [], 20_000, {
        maxBuffer: maxBytes + 64 * 1024,
      });
      if (result.code === 2) throw invalid('文件不存在或不是普通文件。');
      if (result.code !== 0) {
        throw new AppError(502, 'host_preview_failed', summarizeBrowseFailure(result.stderr, '无法读取主机文件。'));
      }
      if (result.stdout.length > maxBytes) {
        throw new AppError(413, 'file_preview_too_large', `文件超过 ${Math.round(maxBytes / (1024 * 1024))} MiB，无法预览。`);
      }
      return result.stdout;
    },

    async listEntries(hostId, rawPath, listOptions) {
      let cleanPath: string;
      try {
        cleanPath = validateBrowsePath(rawPath);
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : '目录路径不合法。');
      }

      if (hostId === LOCAL_WORK_HOST_ID) {
        return listLocalFs(
          LOCAL_WORK_HOST_ID,
          cleanPath,
          homeDir,
          currentPlatform,
          listWindowsDrives,
          listOptions?.refresh,
        );
      }

      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      const result = await runRemoteFs(row, cleanPath, POSIX_BROWSE_SCRIPT);
      if (result.stdout.includes('PWD\0') || result.stdout.includes('ERR\0')) {
        return parsePosixBrowseOutput(hostId, result.stdout);
      }
      const fallback = row.kind === 'wsl'
        ? `无法读取 WSL 发行版 ${row.distro} 的目录。`
        : `无法连接到 SSH 主机 ${row.name} 或读取目录失败。`;
      throw new AppError(502, 'host_browse_failed', summarizeBrowseFailure(result.stderr, fallback));
    },
  };
}
