import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { IPty, IWindowsPtyForkOptions } from 'node-pty';

import { LOCAL_WORK_HOST_ID } from '../../contract/work-projects';
import {
  DEFAULT_WINDOWS_SHELL,
  clampTerminalCols,
  clampTerminalRows,
  normalizeTerminalPreset,
  normalizeWorkTerminalTitle,
  validateWorkTerminalInput,
  type WindowsTerminalShell,
  type WorkTerminalCreateInput,
  type WorkTerminalPatchInput,
  type WorkTerminalPreset,
  type WorkTerminalResumeInput,
  type WorkTerminalServerMessage,
  type WorkTerminalSession,
} from '../../contract/work-terminals';
import type { AppDatabase } from '../db/client';
import { fromDbUuid } from '../db/codecs';
import { requireWorkHostRow, updateWorkHostSecretRow } from '../db/repositories/hosts';
import { requireWorkProjectRow, serializeWorkProject } from '../db/repositories/projects';
import {
  deleteWorkTerminalRow,
  insertWorkTerminalRow,
  listWorkTerminalRows,
  saveWorkTerminalSnapshotRow,
  serializeWorkTerminalRow,
  updateWorkTerminalMetaRow,
} from '../db/repositories/terminals';
import { AppError, invalid, notFound } from '../errors';
import { ensureAskpassScript, posixSingleQuote } from './host-fs';
import {
  defaultRunCommand,
  ensureWslDistroRunning,
  expandHomePath,
  resolveWslCommand,
  type HostCommandRunner,
} from './hosts';

const INSTANCE_ID = 1;
const MAX_SCROLLBACK_CHARS = 128_000;
const SCROLLBACK_PERSIST_DELAY_MS = 1_200;

export type PtyProcess = Pick<IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'>;

export type PtySpawner = (
  file: string,
  args: string[],
  options: IWindowsPtyForkOptions,
) => PtyProcess;

type ActiveTerminal = {
  session: WorkTerminalSession;
  pty: PtyProcess | null;
  scrollback: string;
  cols: number;
  rows: number;
  dirtySnapshot: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<(message: WorkTerminalServerMessage) => void>;
};

export type WorkTerminalService = {
  readonly platform: NodeJS.Platform;
  list(projectId?: string): WorkTerminalSession[];
  create(input: WorkTerminalCreateInput): Promise<WorkTerminalSession>;
  resume(terminalId: string, input?: WorkTerminalResumeInput): Promise<WorkTerminalSession>;
  update(terminalId: string, patch: WorkTerminalPatchInput): WorkTerminalSession;
  attach(
    terminalId: string,
    listener: (message: WorkTerminalServerMessage) => void,
  ): { snapshot: string; session: WorkTerminalSession; detach: () => void };
  write(terminalId: string, data: string): void;
  resize(terminalId: string, cols: number, rows: number): void;
  remove(terminalId: string): void;
  removeByProject(projectId: string): void;
  disposeAll(): void;
};

let cachedNodePty: typeof import('node-pty') | null = null;

function defaultPtySpawn(file: string, args: string[], options: IWindowsPtyForkOptions): PtyProcess {
  if (!cachedNodePty) {
    const require = createRequire(import.meta.url);
    cachedNodePty = require('node-pty') as typeof import('node-pty');
  }
  return cachedNodePty.spawn(file, args, options);
}

function buildTerminalEnv(
  baseEnv: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
  resolvedWindowsPath?: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (typeof value !== 'string') continue;
    if (resolvedWindowsPath && key.toLowerCase() === 'path') continue;
    merged[key] = value;
  }
  if (resolvedWindowsPath) {
    merged.PATH = resolvedWindowsPath;
  }
  merged.TERM = 'xterm-256color';
  merged.COLORTERM = 'truecolor';
  return { ...merged, ...extra };
}

function findEnvCaseInsensitive(envSource: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(envSource)) {
    if (key.toUpperCase() === upper && typeof value === 'string') return value;
  }
  return undefined;
}

export function expandWindowsEnvVars(rawValue: string, envSource: NodeJS.ProcessEnv): string {
  return rawValue.replace(/%([^%]+)%/gu, (full, name: string) => findEnvCaseInsensitive(envSource, name) ?? full);
}

/**
 * Merge current session PATH with fresh Windows Registry Machine/User Path entries so
 * newly installed tools (e.g. `agy`, `claude`, `uv`) work without closing the parent shell.
 */
export function mergeWindowsPathEntries(
  existingPath: string,
  registryPaths: readonly string[],
  envSource: NodeJS.ProcessEnv = process.env,
): string {
  const seen = new Set<string>();
  const combined: string[] = [];
  const pushAll = (raw: string, expand: boolean) => {
    const resolved = expand ? expandWindowsEnvVars(raw, envSource) : raw;
    for (const part of resolved.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(trimmed);
    }
  };
  pushAll(existingPath, false);
  for (const regPath of registryPaths) {
    if (regPath) pushAll(regPath, true);
  }
  return combined.join(';');
}

function parseRegQueryPathValue(stdout: Buffer): string {
  const text = stdout.toString('utf8');
  for (const rawLine of text.split(/\r?\n/u)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/iu.exec(rawLine);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function buildProxyEnvVars(proxyUrl: string | undefined): Record<string, string> {
  const trimmed = proxyUrl?.trim() ?? '';
  if (!trimmed) return {};
  return {
    HTTP_PROXY: trimmed,
    HTTPS_PROXY: trimmed,
    ALL_PROXY: trimmed,
    http_proxy: trimmed,
    https_proxy: trimmed,
    all_proxy: trimmed,
  };
}

function resolveLocalCwd(directory: string, fallbackDirectory?: string): string {
  const candidates = fallbackDirectory && fallbackDirectory !== directory
    ? [directory, fallbackDirectory]
    : [directory];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate);
      return info.isDirectory() ? candidate : dirname(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  const err = lastError as NodeJS.ErrnoException | null;
  if (err?.code === 'ENOENT') throw invalid(`项目目录不存在：${directory}`);
  throw invalid(`无法访问项目目录：${directory}`);
}

function resolvePosixShell(env: NodeJS.ProcessEnv): string {
  if (env.SHELL && existsSync(env.SHELL)) return env.SHELL;
  if (existsSync('/bin/bash')) return '/bin/bash';
  return '/bin/sh';
}

function buildPosixCdTarget(directory: string): string {
  if (directory === '~') return '"$HOME"';
  if (directory.startsWith('~/')) {
    return `"$HOME/"${posixSingleQuote(directory.slice(2))}`;
  }
  return posixSingleQuote(directory);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, '');
}

function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeExtractedPath(rawPath: string, isWindowsLocal: boolean): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 1000 || hasControlChars(trimmed)) return null;
  if (isWindowsLocal && /^\/[A-Za-z]:\//u.test(trimmed)) {
    return trimmed.slice(1).replaceAll('/', '\\');
  }
  return trimmed;
}

/**
 * Passively extract the latest working directory from standard OSC sequences
 * (OSC 7, OSC 9;9, or POSIX title OSC 0/2) and Windows interactive prompts.
 */
export function extractTerminalCwd(
  chunk: string,
  hostId: string,
  currentPlatform: NodeJS.Platform,
): string | null {
  const isWindowsLocal = hostId === LOCAL_WORK_HOST_ID && currentPlatform === 'win32';
  let detected: string | null = null;

  // OSC 9;9;<path> (Windows Terminal CWD escape sequence)
  const osc99 = /\x1b\]9;9;([^\x07\x1b]+)(?:\x07|\x1b\\)/gu;
  for (const match of chunk.matchAll(osc99)) {
    const normalized = normalizeExtractedPath(match[1], isWindowsLocal);
    if (normalized) detected = normalized;
  }

  // OSC 7;file://host/path
  const osc7 = /\x1b\]7;file:\/\/[^/\x07\x1b]*(\/[^\x07\x1b]+)(?:\x07|\x1b\\)/gu;
  for (const match of chunk.matchAll(osc7)) {
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Ignore invalid URI percent sequences.
    }
    const normalized = normalizeExtractedPath(decoded, isWindowsLocal);
    if (normalized) detected = normalized;
  }

  if (detected) {
    if (!isWindowsLocal || existsSync(detected)) return detected;
    return null;
  }

  if (isWindowsLocal) {
    const plain = stripAnsi(chunk);
    const lines = plain.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trimEnd();
      const psMatch = /(?:^|\s)PS ([A-Za-z]:\\[^\r\n>]*?)>$/u.exec(line);
      const cmdMatch = !psMatch ? /^([A-Za-z]:\\[^\r\n>]*?)>$/u.exec(line) : null;
      const candidate = (psMatch?.[1] ?? cmdMatch?.[1])?.trim();
      if (candidate && !hasControlChars(candidate) && existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  // POSIX OSC 0 / 2 window title: `user@host: /path` or `user@host: ~/path`
  const oscTitle = /\x1b\](?:0|2);[^\x07\x1b]*?:\s*(\/[^\x07\x1b]+|~(?:\/[^\x07\x1b]*)?)(?:\x07|\x1b\\)/gu;
  for (const match of chunk.matchAll(oscTitle)) {
    const normalized = normalizeExtractedPath(match[1], false);
    if (normalized) detected = normalized;
  }
  return detected;
}

export function createWorkTerminalService(options: {
  db: AppDatabase;
  ptySpawn?: PtySpawner;
  runCommand?: HostCommandRunner;
  wslCommand?: string | null;
  currentPlatform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fallbackCwd?: string;
  runtimeHostSecrets?: Map<string, string>;
}): WorkTerminalService {
  const { db } = options;
  const ptySpawn = options.ptySpawn ?? defaultPtySpawn;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const currentPlatform = options.currentPlatform ?? process.platform;
  const hasExplicitEnv = options.env !== undefined;
  const env = options.env ?? process.env;
  const wslCommand = options.wslCommand !== undefined ? options.wslCommand : resolveWslCommand(currentPlatform);
  const fallbackCwd = options.fallbackCwd ?? process.cwd();
  const runtimeHostSecrets = options.runtimeHostSecrets ?? new Map<string, string>();
  const terminals = new Map<string, ActiveTerminal>();

  let cachedRegPath: { expiresAt: number; values: string[] } | null = null;
  async function readFreshRegistryPaths(): Promise<string[]> {
    if (currentPlatform !== 'win32' || hasExplicitEnv) return [];
    const now = Date.now();
    if (cachedRegPath && cachedRegPath.expiresAt > now) return cachedRegPath.values;
    try {
      const regExe = 'reg.exe';
      const [machineRes, userRes] = await Promise.all([
        runCommand(regExe, ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'], { timeoutMs: 1_500 }),
        runCommand(regExe, ['query', 'HKCU\\Environment', '/v', 'Path'], { timeoutMs: 1_500 }),
      ]);
      const values = [
        machineRes.code === 0 ? parseRegQueryPathValue(machineRes.stdout) : '',
        userRes.code === 0 ? parseRegQueryPathValue(userRes.stdout) : '',
      ].filter(Boolean);
      cachedRegPath = { expiresAt: now + 5_000, values };
      return values;
    } catch {
      return [];
    }
  }

  for (const row of listWorkTerminalRows(db, INSTANCE_ID)) {
    const session = serializeWorkTerminalRow(row);
    terminals.set(session.id, {
      session,
      pty: null,
      scrollback: row.scrollback ?? '',
      cols: clampTerminalCols(row.cols),
      rows: clampTerminalRows(row.rows),
      dirtySnapshot: false,
      flushTimer: null,
      listeners: new Set(),
    });
  }

  function broadcast(entry: ActiveTerminal, message: WorkTerminalServerMessage): void {
    for (const listener of entry.listeners) {
      listener(message);
    }
  }

  function flushEntryToDb(entry: ActiveTerminal, persistStatus = entry.session.status): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer);
      entry.flushTimer = null;
    }
    if (!terminals.has(entry.session.id)) return;
    entry.dirtySnapshot = false;
    try {
      saveWorkTerminalSnapshotRow(db, INSTANCE_ID, entry.session.id, {
        scrollback: entry.scrollback,
        cwd: entry.session.cwd,
        lastStatus: persistStatus,
        lastExitCode: entry.session.exitCode,
        errorMessage: entry.session.errorMessage ?? null,
      });
    } catch {
      // Ignore persistence failures during concurrent project/terminal deletion.
    }
  }

  function schedulePersist(entry: ActiveTerminal): void {
    entry.dirtySnapshot = true;
    if (entry.flushTimer) return;
    entry.flushTimer = setTimeout(() => {
      entry.flushTimer = null;
      flushEntryToDb(entry);
    }, SCROLLBACK_PERSIST_DELAY_MS);
  }

  function appendScrollback(entry: ActiveTerminal, chunk: string): void {
    const next = entry.scrollback + chunk;
    entry.scrollback = next.length > MAX_SCROLLBACK_CHARS
      ? next.slice(next.length - MAX_SCROLLBACK_CHARS)
      : next;
  }

  function requireEntry(terminalId: string): ActiveTerminal {
    const entry = terminals.get(terminalId);
    if (!entry) throw notFound('终端会话不存在或已关闭。');
    return entry;
  }

  async function spawnTerminalPty(spec: {
    projectId: string;
    hostId: string;
    targetCwd: string;
    fallbackProjectCwd: string;
    proxyUrl?: string;
    preset: WorkTerminalPreset;
    shell?: WindowsTerminalShell;
    command: string;
    cols: number;
    rows: number;
    passwordOverride?: string;
    rememberPassword?: boolean;
  }): Promise<{
    pty: PtyProcess;
    effectiveCwd: string;
    resolvedWindowsShell?: WindowsTerminalShell;
  }> {
    let file = '';
    let args: string[] = [];
    let spawnCwd = fallbackCwd;
    let extraEnv: Record<string, string> = {};
    let effectiveCwd = spec.targetCwd;
    const proxyEnv = buildProxyEnvVars(spec.proxyUrl);

    const isWindowsLocal = spec.hostId === LOCAL_WORK_HOST_ID && currentPlatform === 'win32';
    const resolvedWindowsShell = isWindowsLocal ? (spec.shell ?? DEFAULT_WINDOWS_SHELL) : undefined;
    const freshRegistryPaths = isWindowsLocal ? await readFreshRegistryPaths() : [];
    const mergedWindowsPath = freshRegistryPaths.length > 0
      ? mergeWindowsPathEntries(findEnvCaseInsensitive(env, 'Path') ?? '', freshRegistryPaths, env)
      : undefined;

    if (spec.hostId === LOCAL_WORK_HOST_ID) {
      effectiveCwd = resolveLocalCwd(spec.targetCwd, spec.fallbackProjectCwd);
      spawnCwd = effectiveCwd;
      extraEnv = { ...proxyEnv };
      if (currentPlatform === 'win32') {
        if (resolvedWindowsShell === 'cmd') {
          file = env.ComSpec || 'cmd.exe';
          args = spec.command ? ['/K', spec.command] : [];
        } else {
          file = 'powershell.exe';
          args = spec.command
            ? ['-NoLogo', '-NoExit', '-Command', spec.command]
            : ['-NoLogo'];
        }
      } else {
        file = resolvePosixShell(env);
        args = spec.command
          ? ['-ilc', `${spec.command}; exec ${posixSingleQuote(file)} -il`]
          : ['-il'];
      }
    } else {
      const hostRow = requireWorkHostRow(db, INSTANCE_ID, spec.hostId);
      const dirExpr = buildPosixCdTarget(spec.targetCwd);
      const proxyExports = Object.entries(proxyEnv)
        .map(([key, value]) => `export ${key}=${posixSingleQuote(value)}`)
        .join('; ');
      const proxyPrefix = proxyExports ? `${proxyExports}; ` : '';
      const promptCwdHook = `PROMPT_COMMAND="\${PROMPT_COMMAND:+\$PROMPT_COMMAND; }printf '\\033]7;file://localhost%s\\007' \\"\$PWD\\""`;
      const remoteCommand = spec.command
        ? `cd ${dirExpr} && ${proxyPrefix}${spec.command}; exec \${SHELL:-sh} -il`
        : `cd ${dirExpr} && ${proxyPrefix}${promptCwdHook} exec \${SHELL:-sh} -il`;

      if (hostRow.kind === 'wsl') {
        if (!wslCommand) {
          throw new AppError(400, 'wsl_unavailable', '当前运行环境不支持连接 WSL 终端。');
        }
        const runningCheck = await ensureWslDistroRunning(wslCommand, hostRow.distro, runCommand);
        if (!runningCheck.ok) {
          throw new AppError(400, 'wsl_not_running', runningCheck.message);
        }
        file = wslCommand;
        args = ['-d', hostRow.distro];
        if (hostRow.username) args.push('--user', hostRow.username);
        args.push('--exec', 'sh', '-lc', remoteCommand);
        extraEnv = { WSL_UTF8: '1', ...proxyEnv };
      } else {
        const hostKey = fromDbUuid(hostRow.id);
        const trimmedPassword = spec.passwordOverride?.trim() ?? '';
        if (trimmedPassword) {
          runtimeHostSecrets.set(hostKey, trimmedPassword);
          if (spec.rememberPassword && hostRow.auth_method === 'password') {
            db.transaction(() => updateWorkHostSecretRow(db, INSTANCE_ID, hostKey, trimmedPassword));
          }
        }
        const secret = trimmedPassword || runtimeHostSecrets.get(hostKey) || hostRow.secret_value;

        file = 'ssh';
        args = [
          '-tt',
          '-o', 'ConnectTimeout=8',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-p', String(hostRow.port),
        ];
        if (secret) {
          args.push('-o', 'NumberOfPasswordPrompts=1');
          extraEnv = {
            SSH_ASKPASS: ensureAskpassScript(),
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: env.DISPLAY || 'matrius:0',
            MATRIUS_SSH_PASS: secret,
          };
        } else if (hostRow.auth_method === 'key' && hostRow.private_key_path) {
          // Leave interactive passphrase entry enabled in the PTY if no cached passphrase exists.
          args.push('-i', expandHomePath(hostRow.private_key_path), '-o', 'IdentitiesOnly=yes');
        }
        const target = hostRow.username ? `${hostRow.username}@${hostRow.host}` : hostRow.host;
        args.push('--', target, remoteCommand);
      }
    }

    let childPty: PtyProcess;
    try {
      childPty = ptySpawn(file, args, {
        name: 'xterm-256color',
        cols: spec.cols,
        rows: spec.rows,
        cwd: spawnCwd,
        env: buildTerminalEnv(env, extraEnv, mergedWindowsPath),
      });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '无法启动终端进程。';
      throw new AppError(500, 'terminal_spawn_failed', message);
    }

    return { pty: childPty, effectiveCwd, resolvedWindowsShell };
  }

  function wirePtyLifecycle(entry: ActiveTerminal, childPty: PtyProcess): void {
    entry.pty = childPty;
    childPty.onData((data) => {
      if (entry.pty !== childPty) return;
      appendScrollback(entry, data);
      const nextCwd = extractTerminalCwd(data, entry.session.hostId, currentPlatform);
      if (nextCwd && nextCwd !== entry.session.cwd) {
        entry.session.cwd = nextCwd;
      }
      schedulePersist(entry);
      broadcast(entry, { type: 'output', data });
    });

    childPty.onExit(({ exitCode }) => {
      if (entry.pty !== childPty) return;
      entry.pty = null;
      if (entry.session.status === 'running') {
        entry.session.status = 'exited';
        entry.session.exitCode = Number.isFinite(exitCode) ? exitCode : null;
        flushEntryToDb(entry, 'exited');
        broadcast(entry, {
          type: 'status',
          status: 'exited',
          exitCode: entry.session.exitCode,
        });
      }
    });
  }

  return {
    platform: currentPlatform,
    list(projectId?: string): WorkTerminalSession[] {
      const items = Array.from(terminals.values()).map((entry) => ({ ...entry.session }));
      const trimmed = projectId?.trim();
      return trimmed ? items.filter((item) => item.projectId === trimmed) : items;
    },

    async create(rawInput: WorkTerminalCreateInput): Promise<WorkTerminalSession> {
      const projectRow = requireWorkProjectRow(db, INSTANCE_ID, rawInput.projectId);
      const project = serializeWorkProject(projectRow);
      const requestedPreset = normalizeTerminalPreset(rawInput.preset);
      const requestedShell = requestedPreset === 'shell'
        ? (rawInput.shell ?? (project.hostId === LOCAL_WORK_HOST_ID && currentPlatform === 'win32' ? DEFAULT_WINDOWS_SHELL : undefined))
        : undefined;
      const existingSameFlavor = Array.from(terminals.values())
        .filter((item) => (
          item.session.projectId === project.id
          && item.session.preset === requestedPreset
          && (requestedPreset !== 'shell' || item.session.shell === requestedShell)
        ))
        .length;

      let normalized;
      try {
        normalized = validateWorkTerminalInput(rawInput, existingSameFlavor);
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : '终端参数不合法。');
      }

      const spawned = await spawnTerminalPty({
        projectId: project.id,
        hostId: project.hostId,
        targetCwd: project.directory,
        fallbackProjectCwd: project.directory,
        proxyUrl: project.proxyUrl,
        preset: normalized.preset,
        shell: normalized.shell,
        command: normalized.command,
        cols: normalized.cols,
        rows: normalized.rows,
      });

      const session: WorkTerminalSession = {
        id: randomUUID(),
        projectId: project.id,
        hostId: project.hostId,
        title: normalized.title,
        preset: normalized.preset,
        ...(spawned.resolvedWindowsShell ? { shell: spawned.resolvedWindowsShell } : {}),
        command: normalized.command,
        cwd: spawned.effectiveCwd,
        status: 'running',
        exitCode: null,
        pinned: false,
        createdAt: Date.now(),
      };

      const entry: ActiveTerminal = {
        session,
        pty: spawned.pty,
        scrollback: '',
        cols: normalized.cols,
        rows: normalized.rows,
        dirtySnapshot: false,
        flushTimer: null,
        listeners: new Set(),
      };
      terminals.set(session.id, entry);
      insertWorkTerminalRow(db, INSTANCE_ID, {
        session,
        cols: entry.cols,
        rows: entry.rows,
        scrollback: '',
      });
      wirePtyLifecycle(entry, spawned.pty);

      return { ...session };
    },

    async resume(terminalId: string, rawInput: WorkTerminalResumeInput = {}): Promise<WorkTerminalSession> {
      const entry = requireEntry(terminalId);
      if (entry.session.status === 'running' && entry.pty) {
        return { ...entry.session };
      }

      const projectRow = requireWorkProjectRow(db, INSTANCE_ID, entry.session.projectId);
      const project = serializeWorkProject(projectRow);
      const cols = rawInput.cols !== undefined ? clampTerminalCols(rawInput.cols) : entry.cols;
      const rows = rawInput.rows !== undefined ? clampTerminalRows(rawInput.rows) : entry.rows;
      entry.cols = cols;
      entry.rows = rows;

      const spawned = await spawnTerminalPty({
        projectId: project.id,
        hostId: project.hostId,
        targetCwd: entry.session.cwd || project.directory,
        fallbackProjectCwd: project.directory,
        proxyUrl: project.proxyUrl,
        preset: entry.session.preset,
        shell: entry.session.shell,
        command: entry.session.command,
        cols,
        rows,
        passwordOverride: rawInput.password,
        rememberPassword: rawInput.rememberPassword,
      });

      entry.session.cwd = spawned.effectiveCwd;
      if (spawned.resolvedWindowsShell) {
        entry.session.shell = spawned.resolvedWindowsShell;
      }
      entry.session.status = 'running';
      entry.session.exitCode = null;
      delete entry.session.errorMessage;
      delete entry.session.errorCode;

      if (entry.scrollback) {
        const prefix = entry.scrollback.endsWith('\n') || entry.scrollback.endsWith('\r') ? '' : '\r\n';
        const marker = `${prefix}\x1b[90m── 会话已恢复 · ${spawned.effectiveCwd} ──\x1b[0m\r\n`;
        appendScrollback(entry, marker);
        broadcast(entry, { type: 'output', data: marker });
      }

      wirePtyLifecycle(entry, spawned.pty);
      updateWorkTerminalMetaRow(db, INSTANCE_ID, entry.session.id, {
        cwd: entry.session.cwd,
        cols: entry.cols,
        rows: entry.rows,
        lastStatus: 'running',
        lastExitCode: null,
        errorMessage: null,
      });
      broadcast(entry, { type: 'status', status: 'running', exitCode: null });
      return { ...entry.session };
    },

    update(terminalId, patch) {
      const entry = requireEntry(terminalId);
      if (patch.title !== undefined) {
        try {
          entry.session.title = normalizeWorkTerminalTitle(patch.title);
        } catch (error) {
          throw invalid(error instanceof Error ? error.message : '终端名称不合法。');
        }
      }
      if (patch.pinned !== undefined) {
        entry.session.pinned = Boolean(patch.pinned);
      }
      updateWorkTerminalMetaRow(db, INSTANCE_ID, terminalId, {
        ...(patch.title !== undefined ? { title: entry.session.title } : {}),
        ...(patch.pinned !== undefined ? { pinned: Boolean(entry.session.pinned) } : {}),
      });
      return { ...entry.session };
    },

    attach(terminalId, listener) {
      const entry = requireEntry(terminalId);
      entry.listeners.add(listener);
      return {
        snapshot: entry.scrollback,
        session: { ...entry.session },
        detach: () => {
          entry.listeners.delete(listener);
          if (entry.dirtySnapshot) {
            flushEntryToDb(entry);
          }
        },
      };
    },

    write(terminalId, data) {
      const entry = terminals.get(terminalId);
      if (!entry || !entry.pty || entry.session.status !== 'running' || !data) return;
      try {
        entry.pty.write(data);
      } catch {
        // Ignore writes after concurrent PTY termination.
      }
    },

    resize(terminalId, cols, rows) {
      const entry = terminals.get(terminalId);
      if (!entry) return;
      const nextCols = clampTerminalCols(cols);
      const nextRows = clampTerminalRows(rows);
      entry.cols = nextCols;
      entry.rows = nextRows;
      updateWorkTerminalMetaRow(db, INSTANCE_ID, terminalId, { cols: nextCols, rows: nextRows });
      if (!entry.pty || entry.session.status !== 'running') return;
      try {
        entry.pty.resize(nextCols, nextRows);
      } catch {
        // Ignore resize errors when the process is closing.
      }
    },

    remove(terminalId) {
      const entry = terminals.get(terminalId);
      if (!entry) throw notFound('终端会话不存在或已关闭。');
      if (entry.flushTimer) {
        clearTimeout(entry.flushTimer);
        entry.flushTimer = null;
      }
      terminals.delete(terminalId);
      const activePty = entry.pty;
      entry.pty = null;
      if (entry.session.status === 'running' && activePty) {
        entry.session.status = 'exited';
        try {
          activePty.kill();
        } catch {
          // Ignore kill errors on already-closing PTYs.
        }
      }
      entry.listeners.clear();
      deleteWorkTerminalRow(db, INSTANCE_ID, terminalId);
    },

    removeByProject(projectId) {
      for (const entry of Array.from(terminals.values())) {
        if (entry.session.projectId !== projectId) continue;
        if (entry.flushTimer) {
          clearTimeout(entry.flushTimer);
          entry.flushTimer = null;
        }
        terminals.delete(entry.session.id);
        const activePty = entry.pty;
        entry.pty = null;
        if (entry.session.status === 'running' && activePty) {
          entry.session.status = 'exited';
          try {
            activePty.kill();
          } catch {
            // Ignore shutdown errors.
          }
        }
        entry.listeners.clear();
      }
    },

    disposeAll() {
      for (const entry of terminals.values()) {
        if (entry.flushTimer) {
          clearTimeout(entry.flushTimer);
          entry.flushTimer = null;
        }
        const persistStatus = entry.session.status === 'running' ? 'restored' : entry.session.status;
        flushEntryToDb(entry, persistStatus);
        const activePty = entry.pty;
        entry.pty = null;
        if (entry.session.status === 'running' && activePty) {
          entry.session.status = 'restored';
          try {
            activePty.kill();
          } catch {
            // Ignore shutdown cleanup errors.
          }
        }
        entry.listeners.clear();
      }
      terminals.clear();
    },
  };
}
