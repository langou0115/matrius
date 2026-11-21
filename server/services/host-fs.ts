import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { access, constants as fsConstants, lstat, readdir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';

import {
  LOCAL_WORK_HOST_ID,
  WINDOWS_DRIVES_ROOT,
  validateBrowsePath,
  type HostDirectoryListing,
  type WorkHostEntry,
} from '../../contract/work-projects';
import type { AppDatabase } from '../db/client';
import { fromDbUuid } from '../db/codecs';
import { requireWorkHostRow, type WorkHostRow } from '../db/repositories/hosts';
import { AppError, invalid } from '../errors';
import {
  decodeWslText,
  defaultRunCommand,
  ensureWslDistroRunning,
  expandHomePath,
  resolveWslCommand,
  type HostCommandRunner,
} from './hosts';

const INSTANCE_ID = 1;
const MAX_ENTRIES = 500;
const BROWSE_TIMEOUT_MS = 10_000;

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
  'pwd_out=$(pwd -P 2>/dev/null || pwd)',
  'printf "PWD\\0%s\\0" "$pwd_out"',
  'count=0',
  'for entry in .* *; do',
  '  [ "$entry" = "." ] || [ "$entry" = ".." ] && continue',
  '  [ ! -e "$entry" ] && [ ! -L "$entry" ] && continue',
  '  count=$((count + 1))',
  '  if [ "$count" -gt 1500 ]; then printf "TRUNC\\01\\0"; break; fi',
  '  if [ -d "$entry" ]; then',
  '    if [ -r "$entry" ] && [ -x "$entry" ]; then tag=d1; else tag=d0; fi',
  '  else',
  '    if [ -r "$entry" ]; then tag=f1; else tag=f0; fi',
  '  fi',
  '  printf "%s\\0%s\\0" "$tag" "$entry"',
  'done',
].join('\n');

export type HostFsService = {
  listEntries(hostId: string, rawPath?: string): Promise<HostDirectoryListing>;
};

let cachedAskpassPath: string | null = null;

export function ensureAskpassScript(): string {
  if (cachedAskpassPath && existsSync(cachedAskpassPath)) return cachedAskpassPath;
  if (process.platform === 'win32') {
    const target = join(tmpdir(), 'matrius-ssh-askpass.cmd');
    writeFileSync(target, '@echo off\r\necho %MATRIUS_SSH_PASS%\r\n', 'utf8');
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
    return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  if (sorted.length > MAX_ENTRIES) {
    return { entries: sorted.slice(0, MAX_ENTRIES), truncated: true };
  }
  return { entries: sorted, truncated: false };
}

const DRIVE_CHECK_TIMEOUT_MS = 400;

async function defaultListWindowsDrives(): Promise<string[]> {
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

function isWindowsDrivesRequest(rawPath: string, currentPlatform: NodeJS.Platform): boolean {
  if (currentPlatform !== 'win32') return false;
  return rawPath === WINDOWS_DRIVES_ROOT || rawPath === '/' || rawPath === '\\';
}

function resolveLocalTarget(rawPath: string, homeDir: string, currentPlatform: NodeJS.Platform): string {
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
  listWindowsDrives: () => Promise<string[]>,
): Promise<HostDirectoryListing> {
  const drivesPromise = currentPlatform === 'win32' ? listWindowsDrives() : Promise.resolve<string[]>([]);

  if (isWindowsDrivesRequest(rawPath, currentPlatform)) {
    const drives = await drivesPromise;
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
  let info;
  let dirents;
  try {
    info = await stat(requested);
    targetPath = await realpath(requested).catch(() => requested);
    if (!info.isDirectory()) {
      throw invalid(`所选路径不是目录：${targetPath}`);
    }
    dirents = await readdir(targetPath, { withFileTypes: true });
  } catch (error) {
    if (error instanceof AppError) throw error;
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') throw new AppError(404, 'path_not_found', `目录不存在：${requested}`);
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new AppError(403, 'path_forbidden', `没有权限访问目录：${requested}`);
    throw new AppError(400, 'path_error', `无法读取目录：${err.message}`);
  }

  const [rawEntries, drives] = await Promise.all([
    (async () => {
      const items: WorkHostEntry[] = [];
      for (const dirent of dirents) {
        const entryPath = join(targetPath, dirent.name);
        let kind: 'directory' | 'file' = dirent.isDirectory() ? 'directory' : 'file';
        if (dirent.isSymbolicLink()) {
          const resolvedKind = await stat(entryPath).then((entryStat) => (entryStat.isDirectory() ? 'directory' : 'file')).catch(() => 'file' as const);
          kind = resolvedKind;
        } else if (!dirent.isDirectory() && !dirent.isFile()) {
          const fallback = await lstat(entryPath).then((entryStat) => (entryStat.isDirectory() ? 'directory' : 'file')).catch(() => null);
          if (!fallback) continue;
          kind = fallback;
        }
        const mode = kind === 'directory' ? (fsConstants.R_OK | fsConstants.X_OK) : fsConstants.R_OK;
        const accessible = await access(entryPath, mode).then(() => true).catch(() => false);
        items.push({ kind, name: dirent.name, path: entryPath, accessible });
      }
      return items;
    })(),
    drivesPromise,
  ]);

  const { entries, truncated } = sortEntries(rawEntries);
  const parent = dirname(targetPath);
  const parentPath = parent !== targetPath
    ? parent
    : (currentPlatform === 'win32' && /^[A-Za-z]:\\?$/u.test(targetPath) && drives.length > 0 ? WINDOWS_DRIVES_ROOT : null);

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
  const listWindowsDrives = options.listWindowsDrives ?? defaultListWindowsDrives;
  const runtimeHostSecrets = options.runtimeHostSecrets ?? new Map<string, string>();

  async function listWslFs(hostId: string, row: WorkHostRow, rawPath: string): Promise<HostDirectoryListing> {
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
    args.push('--exec', 'sh', '-c', POSIX_BROWSE_SCRIPT, '_', rawPath);

    const result = await runCommand(wslCommand, args, {
      timeoutMs: BROWSE_TIMEOUT_MS,
      env: { WSL_UTF8: '1' },
    });

    if (result.errorCode === 'ENOENT') {
      throw new AppError(400, 'wsl_unavailable', '未找到 wsl.exe，无法浏览 WSL 发行版目录。');
    }
    if (result.timedOut) {
      throw new AppError(504, 'host_browse_timeout', `读取 WSL 发行版 ${row.distro} 目录超时。`);
    }
    if (result.stdout.includes('PWD\0') || result.stdout.includes('ERR\0')) {
      return parsePosixBrowseOutput(hostId, result.stdout);
    }
    throw new AppError(
      502,
      'host_browse_failed',
      summarizeBrowseFailure(result.stderr, `无法读取 WSL 发行版 ${row.distro} 的目录。`),
    );
  }

  async function listSshFs(hostId: string, row: WorkHostRow, rawPath: string): Promise<HostDirectoryListing> {
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
    if (resolvedSecret) {
      args.push('-o', 'NumberOfPasswordPrompts=1');
      cmdEnv.SSH_ASKPASS = ensureAskpassScript();
      cmdEnv.SSH_ASKPASS_REQUIRE = 'force';
      cmdEnv.DISPLAY = env.DISPLAY || 'matrius:0';
      cmdEnv.MATRIUS_SSH_PASS = resolvedSecret;
    } else {
      args.push('-o', 'BatchMode=yes');
      if (row.auth_method === 'key' && row.private_key_path) {
        args.push('-i', expandHomePath(row.private_key_path), '-o', 'IdentitiesOnly=yes');
      }
    }

    const target = row.username ? `${row.username}@${row.host}` : row.host;
    const remoteCommand = `sh -c ${posixSingleQuote(POSIX_BROWSE_SCRIPT)} _ ${posixSingleQuote(rawPath)}`;
    args.push('--', target, remoteCommand);

    const result = await runCommand('ssh', args, {
      timeoutMs: BROWSE_TIMEOUT_MS,
      env: cmdEnv,
    });

    if (result.errorCode === 'ENOENT') {
      throw new AppError(400, 'ssh_unavailable', '本机未找到 ssh 客户端，请先安装 OpenSSH Client。');
    }
    if (result.timedOut) {
      throw new AppError(504, 'host_browse_timeout', `读取远程主机 ${row.name} 目录超时。`);
    }
    if (result.stdout.includes('PWD\0') || result.stdout.includes('ERR\0')) {
      return parsePosixBrowseOutput(hostId, result.stdout);
    }
    throw new AppError(
      502,
      'host_browse_failed',
      summarizeBrowseFailure(result.stderr, `无法连接到 SSH 主机 ${row.name} 或读取目录失败。`),
    );
  }

  return {
    async listEntries(hostId, rawPath) {
      let cleanPath: string;
      try {
        cleanPath = validateBrowsePath(rawPath);
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : '目录路径不合法。');
      }

      if (hostId === LOCAL_WORK_HOST_ID) {
        return listLocalFs(LOCAL_WORK_HOST_ID, cleanPath, homeDir, currentPlatform, listWindowsDrives);
      }

      const row = requireWorkHostRow(db, INSTANCE_ID, hostId);
      if (row.kind === 'wsl') {
        return listWslFs(hostId, row, cleanPath);
      }
      return listSshFs(hostId, row, cleanPath);
    },
  };
}
