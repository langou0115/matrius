import { execFile } from 'node:child_process';
import { mkdtemp, opendir, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import type { WorkFileSearchResponse } from '../../contract/work-projects';
import { defaultListWindowsDrives } from './host-fs';

const exec = promisify(execFile);
const LIMIT = 60;
const MAX_ENTRIES = 250_000;
const REFRESH_MS = 120_000;
const WINDOWS_FILE_PATH = /^[a-z]:[\\/][^:]+$/iu;
const skipped = new Set(['.git', 'node_modules', '$recycle.bin', 'system volume information']);

function normalized(value: string): string {
  return value.replaceAll('\\', '/').toLowerCase();
}

function inDirectory(directory: string | undefined, path: string): boolean {
  if (!directory) return false;
  const child = relative(directory, path);
  return Boolean(child) && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child);
}

async function searchEverything(terms: readonly string[], signal: AbortSignal): Promise<string[]> {
  const temp = await mkdtemp(join(tmpdir(), 'matrius-es-'));
  try {
    const output = join(temp, 'results.txt');
    const regex = '^' + terms.map((term) => {
      const pattern = term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replaceAll('/', '[\\\\/]')
        .replaceAll('"', '\\x22');
      return `(?=.*${pattern})`;
    }).join('') + '.*';
    await exec('es.exe', ['-p', '/a-d', '-n', '240', '-timeout', '750', '-export-txt', output, '-r', regex], {
      signal, timeout: 1800, windowsHide: true, maxBuffer: 64 * 1024,
    });
    return (await readFile(output, 'utf8')).replace(/^\uFEFF/u, '').split(/\r?\n/u)
      .filter((path) => WINDOWS_FILE_PATH.test(path));
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}

type Entry = { path: string; name: string; key: string; nameKey: string };
function indexEntry(path: string): Entry {
  const name = basename(path);
  return { path, name, key: normalized(path), nameKey: name.toLowerCase() };
}

type Index = {
  entries: Entry[];
  previous?: Entry[];
  running: boolean;
  limited: boolean;
  time: number;
  root?: string;
};

export function createWorkFileSearch({
  home = homedir(),
  platform = process.platform,
  listRoots = platform === 'win32' ? defaultListWindowsDrives : async () => [sep],
}: { home?: string; platform?: NodeJS.Platform; listRoots?: () => Promise<string[]> } = {}) {
  let index: Index | undefined;
  let retryEverythingAt = 0;
  let emptyNativeQuery: { query: string; expiresAt: number } | undefined;
  let disposed = false;
  const identify = (path: string) => platform === 'win32' ? normalized(path) : path;

  async function scan(current: Index) {
    const folders = current.root && identify(current.root) !== identify(home) ? [current.root, home] : [home];
    const roots = listRoots().catch(() => []);
    const visited = new Set<string>();
    const firstRoots = folders.length;
    for (let cursor = 0; cursor < folders.length && !disposed && current === index; cursor++) {
      const path = folders[cursor];
      const key = identify(path);
      if (visited.has(key)) continue;
      visited.add(key);
      try {
        const folder = await opendir(path);
        for await (const entry of folder) {
          if (disposed || current !== index) return;
          const target = join(path, entry.name);
          const system = path === '/' && ['proc', 'sys', 'dev', 'run'].includes(entry.name)
            || platform === 'win32' && /^[a-z]:\\$/iu.test(path) && entry.name.toLowerCase() === 'windows';
          if (entry.isDirectory() && !system && !skipped.has(entry.name.toLowerCase())) folders.push(target);
          if (entry.isFile()) current.entries.push(indexEntry(target));
          if (current.entries.length >= MAX_ENTRIES || folders.length >= MAX_ENTRIES) {
            current.limited = true;
            return;
          }
        }
      } catch {
        // Unreadable folders do not prevent indexing other locations.
      }
      if (cursor === firstRoots - 1) folders.push(...await roots);
    }
  }

  function getIndex(root?: string) {
    if (index && index.root === root && (index.running || Date.now() - index.time < REFRESH_MS)) return index;
    const current: Index = { root, entries: [], previous: index?.entries, running: true, limited: false, time: 0 };
    index = current;
    void scan(current).finally(() => {
      current.running = false;
      current.previous = undefined;
      current.time = Date.now();
    });
    return current;
  }

  return {
    close() { disposed = true; index = undefined; },
    async search(query: string, root: string | undefined, signal: AbortSignal): Promise<WorkFileSearchResponse> {
      const terms = normalized(query).split(/\s+/u).filter(Boolean);
      const absolute = platform === 'win32' ? WINDOWS_FILE_PATH.test(query) : isAbsolute(query);
      const exact = absolute && (await stat(query).catch(() => null))?.isFile() ? indexEntry(query) : undefined;
      let native: Entry[] | undefined;
      const recentEmptyQuery = emptyNativeQuery?.query === query && emptyNativeQuery.expiresAt > Date.now();
      if (platform === 'win32' && Date.now() >= retryEverythingAt && !recentEmptyQuery) {
        try {
          native = (await searchEverything(terms, signal)).map(indexEntry);
          if (!native.length) emptyNativeQuery = { query, expiresAt: Date.now() + 10_000 };
        } catch {
          signal.throwIfAborted();
          retryEverythingAt = Date.now() + 10_000;
        }
      }
      signal.throwIfAborted();
      const local = native?.length ? undefined : getIndex(root);
      const entries = local?.entries ?? native ?? [];
      const matches = new Map<string, { entry: Entry; score: number }>();
      const phrase = terms.join(' ');
      for (const source of [exact ? [exact] : [], entries, local?.previous ?? []]) {
        for (const entry of source) {
          const identity = identify(entry.path);
          if (!terms.every((term) => entry.key.includes(term)) || matches.has(identity)) continue;
          const score = entry === exact || entry.nameKey === phrase ? 0
            : entry.nameKey.startsWith(terms[0]) ? 1
              : terms.every((term) => entry.nameKey.includes(term)) ? 2 : 3;
          matches.set(identity, { entry, score });
        }
      }
      const sorted = [...matches.values()].sort((a, b) => a.score - b.score
        || a.entry.name.length - b.entry.name.length || a.entry.key.localeCompare(b.entry.key));
      const items = sorted.slice(0, LIMIT).map(({ entry }) => ({
        kind: 'file' as const, name: entry.name, path: entry.path, accessible: true,
        ...(!inDirectory(root, entry.path) && { localOutsideProject: true }),
      }));
      return {
        items, source: local ? 'local' : 'everything', indexing: local?.running ?? false,
        limited: sorted.length > LIMIT || Boolean(local?.limited),
      };
    },
  };
}
