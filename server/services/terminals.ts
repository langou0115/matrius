import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import type { IPty, IWindowsPtyForkOptions } from 'node-pty';

import {
  WORK_CLI_PROVIDER_LABELS,
  buildCliResumeCommand,
  validateCliSessionId,
  type WorkCliProvider,
} from '../../contract/work-cli';
import {
  LOCAL_WORK_HOST_ID,
  resolveWorkTerminalCommand,
  resolveWorkTerminalProxyUrl,
} from '../../contract/work-projects';
import {
  DEFAULT_WINDOWS_SHELL,
  advanceTerminalModeState,
  buildTerminalSnapshotWithModes,
  clampTerminalCols,
  clampTerminalRows,
  createTerminalModeState,
  defaultTerminalCommand,
  normalizeConptyClearChunk,
  normalizeTerminalPreset,
  normalizeWorkTerminalTitle,
  validateWorkTerminalInput,
  type WindowsTerminalShell,
  type WorkTerminalAltScreenMode,
  type WorkTerminalCreateInput,
  type WorkTerminalModeState,
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
  clearWorkTerminalScrollbacks,
  deleteWorkTerminalRow,
  getWorkSettingsRow,
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
  resolveSshCommand,
  resolveWslCommand,
  type HostCommandRunner,
} from './hosts';

const INSTANCE_ID = 1;
const MAX_SCROLLBACK_CHARS = 128_000;
const SCROLLBACK_COMPACT_THRESHOLD = 192_000;
const SCROLLBACK_PERSIST_DELAY_MS = 1_200;
const OUTPUT_COALESCE_MS = 6;
const OUTPUT_COALESCE_MAX_CHARS = 32_768;
const FLOW_CONTROL_HIGH_WATERMARK = 100_000;
const FLOW_CONTROL_LOW_WATERMARK = 5_000;

export type PtyProcess = Pick<IPty, 'write' | 'resize' | 'kill' | 'onData' | 'onExit'> & {
  readonly pid?: number;
  pause?: () => void;
  resume?: () => void;
};

export type PtySpawner = (
  file: string,
  args: string[],
  options: IWindowsPtyForkOptions,
) => PtyProcess;

type ActiveTerminal = {
  session: WorkTerminalSession;
  pty: PtyProcess | null;
  scrollbackChunks: string[];
  scrollbackLength: number;
  modeState: WorkTerminalModeState;
  scrollbackBaseAltScreen: WorkTerminalAltScreenMode | null;
  cols: number;
  rows: number;
  dirtySnapshot: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingOutput: string;
  outputTimer: ReturnType<typeof setTimeout> | null;
  unackedChars: number;
  ptyPaused: boolean;
  listeners: Set<(message: WorkTerminalServerMessage) => void>;
};

export type WorkTerminalService = {
  readonly platform: NodeJS.Platform;
  readonly windowsBuild?: number;
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
  ack?: (terminalId: string, chars: number) => void;
  remove(terminalId: string): void;
  removeByProject(projectId: string): void;
  setPersistScrollback?: (enabled: boolean) => void;
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

export function extractCommandExecutable(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    return end > 1 ? trimmed.slice(1, end).trim() : trimmed.slice(1).trim();
  }
  const spaceIndex = trimmed.search(/\s/u);
  return spaceIndex >= 0 ? trimmed.slice(0, spaceIndex) : trimmed;
}

export type WorkCliInstallChecker = (input: {
  hostId: string;
  preset: WorkCliProvider;
  binary: string;
  mergedWindowsPath?: string;
  passwordOverride?: string;
  rememberPassword?: boolean;
}) => Promise<boolean>;

export function createWorkTerminalService(options: {
  db: AppDatabase;
  ptySpawn?: PtySpawner;
  runCommand?: HostCommandRunner;
  wslCommand?: string | null;
  currentPlatform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fallbackCwd?: string;
  runtimeHostSecrets?: Map<string, string>;
  checkCliCommand?: WorkCliInstallChecker;
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

  function isLocalCliInstalled(binary: string, mergedWindowsPath?: string): boolean | null {
    if (!binary) return false;
    if (binary.includes('/') || binary.includes('\\')) {
      if (!existsSync(binary)) return false;
      if (currentPlatform === 'win32') return true;
      try {
        accessSync(binary, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    const rawPath = mergedWindowsPath ?? findEnvCaseInsensitive(env, 'PATH') ?? '';
    const delimiter = currentPlatform === 'win32' ? ';' : ':';
    const dirs = rawPath
      .split(delimiter)
      .map((entry) => entry.trim().replace(/^"(.*)"$/u, '$1'))
      .filter(Boolean);

    if (currentPlatform === 'win32') {
      const rawPathext = findEnvCaseInsensitive(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD';
      const exts = new Set(
        rawPathext.split(';').map((ext) => ext.trim()).filter(Boolean),
      );
      exts.add('.PS1');
      exts.add('.CMD');
      exts.add('.EXE');
      const hasExt = /\.[A-Za-z0-9]{1,8}$/u.test(binary);
      for (const dir of dirs) {
        if (hasExt && existsSync(join(dir, binary))) return true;
        for (const ext of exts) {
          if (existsSync(join(dir, `${binary}${ext}`)) || existsSync(join(dir, `${binary}${ext.toLowerCase()}`))) {
            return true;
          }
        }
      }
      return false;
    }

    for (const dir of dirs) {
      const candidate = join(dir, binary);
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Keep searching PATH directories.
      }
    }
    return hasExplicitEnv ? false : null;
  }

  async function defaultCheckCliCommand(input: {
    hostId: string;
    preset: WorkCliProvider;
    binary: string;
    mergedWindowsPath?: string;
    passwordOverride?: string;
    rememberPassword?: boolean;
  }): Promise<boolean> {
    if (input.hostId === LOCAL_WORK_HOST_ID) {
      const direct = isLocalCliInstalled(input.binary, input.mergedWindowsPath);
      if (direct !== null) return direct;
      const shell = resolvePosixShell(env);
      const res = await runCommand(
        shell,
        ['-ilc', 'command -v -- "$1" >/dev/null 2>&1', '_', input.binary],
        { env: buildTerminalEnv(env), timeoutMs: 3_000 },
      );
      return res.code === 0;
    }

    const hostRow = requireWorkHostRow(db, INSTANCE_ID, input.hostId);
    const probeCmd = `command -v -- ${posixSingleQuote(input.binary)} >/dev/null 2>&1 || "\${SHELL:-sh}" -ilc ${posixSingleQuote(`command -v -- ${posixSingleQuote(input.binary)} >/dev/null 2>&1`)}`;
    if (hostRow.kind === 'wsl') {
      if (!wslCommand) {
        throw new AppError(400, 'wsl_unavailable', '当前运行环境不支持连接 WSL 终端。');
      }
      const runningCheck = await ensureWslDistroRunning(wslCommand, hostRow.distro, runCommand);
      if (!runningCheck.ok) {
        throw new AppError(400, 'wsl_not_running', runningCheck.message);
      }
      const args = ['-d', hostRow.distro];
      if (hostRow.username) args.push('--user', hostRow.username);
      args.push('--exec', 'sh', '-lc', probeCmd);
      const res = await runCommand(wslCommand, args, { timeoutMs: 4_000 });
      return res.code === 0;
    }

    const hostKey = fromDbUuid(hostRow.id);
    const trimmedPassword = input.passwordOverride?.trim() ?? '';
    if (trimmedPassword) {
      runtimeHostSecrets.set(hostKey, trimmedPassword);
      if (input.rememberPassword && hostRow.auth_method === 'password') {
        db.transaction(() => updateWorkHostSecretRow(db, INSTANCE_ID, hostKey, trimmedPassword));
      }
    }
    const secret = trimmedPassword || runtimeHostSecrets.get(hostKey) || hostRow.secret_value;
    // If password authentication has not been unlocked yet, let PTY spawn prompt interactively.
    if (!secret && hostRow.auth_method === 'password') {
      return true;
    }

    const args = [
      '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-p', String(hostRow.port),
    ];
    let sshEnv: Record<string, string> | undefined;
    if (hostRow.auth_method === 'key' && hostRow.private_key_path) {
      args.push('-i', expandHomePath(hostRow.private_key_path), '-o', 'IdentitiesOnly=yes');
    }
    if (secret) {
      args.push('-o', 'NumberOfPasswordPrompts=1');
      sshEnv = {
        SSH_ASKPASS: ensureAskpassScript(),
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: env.DISPLAY || 'matrius:0',
        MATRIUS_SSH_PASS: secret,
      };
    } else {
      args.push('-o', 'BatchMode=yes');
    }
    const target = hostRow.username ? `${hostRow.username}@${hostRow.host}` : hostRow.host;
    args.push('--', target, probeCmd);
    const res = await runCommand('ssh', args, { env: sshEnv, timeoutMs: 8_000 });
    if (res.code === 0) return true;
    if (res.code === 255) {
      throw new AppError(400, 'ssh_connection_failed', '无法连接 SSH 主机检查命令，请先检查主机连接或密码设置。');
    }
    return false;
  }

  const checkCliCommand: WorkCliInstallChecker = options.checkCliCommand ?? defaultCheckCliCommand;

  async function ensureCliInstalled(input: {
    hostId: string;
    preset: WorkTerminalPreset;
    command: string;
    mergedWindowsPath?: string;
    passwordOverride?: string;
    rememberPassword?: boolean;
  }): Promise<void> {
    if (input.preset === 'shell') return;
    const rawCommand = input.command.trim() || defaultTerminalCommand(input.preset);
    const binary = extractCommandExecutable(rawCommand);
    if (!binary) return;
    const installed = await checkCliCommand({
      hostId: input.hostId,
      preset: input.preset,
      binary,
      mergedWindowsPath: input.mergedWindowsPath,
      passwordOverride: input.passwordOverride,
      rememberPassword: input.rememberPassword,
    });
    if (!installed) {
      throw new AppError(
        400,
        'cli_not_installed',
        `当前主机未安装 ${WORK_CLI_PROVIDER_LABELS[input.preset]}（未找到命令 ${binary}），请先安装后再试。`,
      );
    }
  }

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

  let persistScrollback = false;
  try {
    persistScrollback = getWorkSettingsRow(db, INSTANCE_ID).persistTerminalScrollback;
  } catch {
    persistScrollback = false;
  }

  for (const row of listWorkTerminalRows(db, INSTANCE_ID)) {
    const session = serializeWorkTerminalRow(row);
    const initialScrollback = persistScrollback ? (row.scrollback ?? '') : '';
    terminals.set(session.id, {
      session,
      pty: null,
      scrollbackChunks: initialScrollback ? [initialScrollback] : [],
      scrollbackLength: initialScrollback.length,
      modeState: createTerminalModeState(),
      scrollbackBaseAltScreen: null,
      cols: clampTerminalCols(row.cols),
      rows: clampTerminalRows(row.rows),
      dirtySnapshot: false,
      flushTimer: null,
      pendingOutput: '',
      outputTimer: null,
      unackedChars: 0,
      ptyPaused: false,
      listeners: new Set(),
    });
  }

  function resetFlowControl(entry: ActiveTerminal): void {
    entry.unackedChars = 0;
    if (entry.ptyPaused) {
      entry.ptyPaused = false;
      try {
        entry.pty?.resume?.();
      } catch {
        // Ignore resume errors on closed PTY.
      }
    }
  }

  function trackOutputFlowControl(entry: ActiveTerminal, charCount: number): void {
    if (charCount <= 0 || entry.listeners.size === 0 || !entry.pty?.pause) return;
    entry.unackedChars += charCount;
    if (!entry.ptyPaused && entry.unackedChars >= FLOW_CONTROL_HIGH_WATERMARK) {
      entry.ptyPaused = true;
      try {
        entry.pty.pause();
      } catch {
        entry.ptyPaused = false;
      }
    }
  }

  function broadcast(entry: ActiveTerminal, message: WorkTerminalServerMessage): void {
    if (message.type === 'output') {
      trackOutputFlowControl(entry, message.data.length);
    }
    for (const listener of entry.listeners) {
      listener(message);
    }
  }

  function clearOutputCoalesce(entry: ActiveTerminal): void {
    if (entry.outputTimer) {
      clearTimeout(entry.outputTimer);
      entry.outputTimer = null;
    }
    entry.pendingOutput = '';
  }

  function flushPendingOutput(entry: ActiveTerminal): void {
    if (entry.outputTimer) {
      clearTimeout(entry.outputTimer);
      entry.outputTimer = null;
    }
    if (!entry.pendingOutput) return;
    const data = entry.pendingOutput;
    entry.pendingOutput = '';
    broadcast(entry, { type: 'output', data });
  }

  function shouldCoalesceLeadingChunk(data: string): boolean {
    if (data.includes('\x1b[2J') || data.includes('\x1b[3J') || data.includes('\x1b[?1049')) {
      return true;
    }
    const syncStart = data.lastIndexOf('\x1b[?2026h');
    if (syncStart >= 0 && data.indexOf('\x1b[?2026l', syncStart) < 0) {
      return true;
    }
    const lastEsc = data.lastIndexOf('\x1b');
    if (lastEsc >= 0 && lastEsc >= data.length - 32) {
      const tail = data.slice(lastEsc + 1);
      if (tail.length === 0 || (tail.startsWith('[') && !/[A-Za-z~@]$/u.test(tail))) {
        return true;
      }
    }
    return false;
  }

  function enqueuePtyOutput(entry: ActiveTerminal, data: string): void {
    if (!data) return;
    // Deliver normal interactive chunks immediately unless the burst begins with a
    // screen clear / synchronized redraw / partial control sequence, then coalesce
    // rapid follow-ups inside a 6ms window so full TUI repaints land atomically.
    if (!entry.outputTimer && !entry.pendingOutput && !shouldCoalesceLeadingChunk(data)) {
      broadcast(entry, { type: 'output', data });
      entry.outputTimer = setTimeout(() => {
        entry.outputTimer = null;
        if (entry.pendingOutput) {
          flushPendingOutput(entry);
        }
      }, OUTPUT_COALESCE_MS);
      return;
    }
    entry.pendingOutput += data;
    if (entry.pendingOutput.length >= OUTPUT_COALESCE_MAX_CHARS) {
      flushPendingOutput(entry);
      return;
    }
    if (!entry.outputTimer) {
      entry.outputTimer = setTimeout(() => {
        entry.outputTimer = null;
        if (entry.pendingOutput) {
          flushPendingOutput(entry);
        }
      }, OUTPUT_COALESCE_MS);
    }
  }

  function materializeScrollback(entry: ActiveTerminal): string {
    if (entry.scrollbackChunks.length === 0) return '';
    if (entry.scrollbackChunks.length === 1 && entry.scrollbackLength <= MAX_SCROLLBACK_CHARS) {
      return entry.scrollbackChunks[0];
    }
    const joined = entry.scrollbackChunks.join('');
    if (joined.length > MAX_SCROLLBACK_CHARS) {
      const overflow = joined.length - MAX_SCROLLBACK_CHARS;
      const droppedState = advanceTerminalModeState(
        createTerminalModeState({ altScreen: entry.scrollbackBaseAltScreen }),
        joined.slice(0, overflow),
      );
      entry.scrollbackBaseAltScreen = droppedState.altScreen;
      const trimmed = joined.slice(overflow);
      entry.scrollbackChunks = trimmed ? [trimmed] : [];
      entry.scrollbackLength = trimmed.length;
      return trimmed;
    }
    entry.scrollbackChunks = joined ? [joined] : [];
    entry.scrollbackLength = joined.length;
    return joined;
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
        scrollback: persistScrollback ? materializeScrollback(entry) : '',
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

  function parseWindowsBuildNumber(): number | undefined {
    if (currentPlatform !== 'win32') return undefined;
    const match = /^\d+\.\d+\.(\d+)/u.exec(release());
    if (!match?.[1]) return undefined;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  function appendScrollback(entry: ActiveTerminal, chunk: string): void {
    if (!chunk) return;
    entry.modeState = advanceTerminalModeState(entry.modeState, chunk);
    const lastClearIndex = chunk.lastIndexOf('\x1b[3J');
    if (lastClearIndex >= 0) {
      let droppedState = createTerminalModeState({ altScreen: entry.scrollbackBaseAltScreen });
      for (const prev of entry.scrollbackChunks) {
        droppedState = advanceTerminalModeState(droppedState, prev);
      }
      if (lastClearIndex > 0) {
        droppedState = advanceTerminalModeState(droppedState, chunk.slice(0, lastClearIndex));
      }
      entry.scrollbackBaseAltScreen = droppedState.altScreen;
      const normalized = normalizeConptyClearChunk(chunk.slice(lastClearIndex));
      if (normalized.length > MAX_SCROLLBACK_CHARS) {
        const overflow = normalized.length - MAX_SCROLLBACK_CHARS;
        entry.scrollbackBaseAltScreen = advanceTerminalModeState(
          createTerminalModeState({ altScreen: entry.scrollbackBaseAltScreen }),
          normalized.slice(0, overflow),
        ).altScreen;
        const trimmed = normalized.slice(overflow);
        entry.scrollbackChunks = trimmed ? [trimmed] : [];
        entry.scrollbackLength = trimmed.length;
      } else {
        entry.scrollbackChunks = normalized ? [normalized] : [];
        entry.scrollbackLength = normalized.length;
      }
      return;
    }

    const lastIdx = entry.scrollbackChunks.length - 1;
    if (lastIdx >= 0 && entry.scrollbackChunks[lastIdx].slice(-64).includes('\x1b[3J')) {
      const prev = entry.scrollbackChunks[lastIdx];
      const merged = normalizeConptyClearChunk(prev + chunk);
      entry.scrollbackLength += merged.length - prev.length;
      entry.scrollbackChunks[lastIdx] = merged;
    } else {
      entry.scrollbackChunks.push(chunk);
      entry.scrollbackLength += chunk.length;
    }

    if (entry.scrollbackLength > SCROLLBACK_COMPACT_THRESHOLD) {
      materializeScrollback(entry);
    }
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

    await ensureCliInstalled({
      hostId: spec.hostId,
      preset: spec.preset,
      command: spec.command,
      mergedWindowsPath,
      passwordOverride: spec.passwordOverride,
      rememberPassword: spec.rememberPassword,
    });

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

        file = resolveSshCommand(currentPlatform);
        args = [
          '-tt',
          '-o', 'ConnectTimeout=8',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-p', String(hostRow.port),
        ];
        if (hostRow.auth_method === 'key' && hostRow.private_key_path) {
          args.push('-i', expandHomePath(hostRow.private_key_path), '-o', 'IdentitiesOnly=yes');
        }
        if (secret) {
          args.push('-o', 'NumberOfPasswordPrompts=1');
          extraEnv = {
            SSH_ASKPASS: ensureAskpassScript(),
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: env.DISPLAY || 'matrius:0',
            MATRIUS_SSH_PASS: secret,
          };
        }
        const target = hostRow.username ? `${hostRow.username}@${hostRow.host}` : hostRow.host;
        args.push('--', target, remoteCommand);
      }
    }

    let childPty: PtyProcess;
    const spawnOptions: IWindowsPtyForkOptions = {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spawnCwd,
      env: buildTerminalEnv(env, extraEnv, mergedWindowsPath),
      ...(currentPlatform === 'win32' ? { useConpty: true, useConptyDll: true } : {}),
    };
    try {
      childPty = ptySpawn(file, args, spawnOptions);
    } catch (firstError) {
      if (currentPlatform === 'win32' && spawnOptions.useConptyDll) {
        try {
          const { useConptyDll: _unused, ...fallbackOptions } = spawnOptions;
          childPty = ptySpawn(file, args, fallbackOptions);
        } catch (error) {
          const message = error instanceof Error && error.message ? error.message : '无法启动终端进程。';
          throw new AppError(500, 'terminal_spawn_failed', message);
        }
      } else {
        const message = firstError instanceof Error && firstError.message ? firstError.message : '无法启动终端进程。';
        throw new AppError(500, 'terminal_spawn_failed', message);
      }
    }

    return { pty: childPty, effectiveCwd, resolvedWindowsShell };
  }

  function wirePtyLifecycle(entry: ActiveTerminal, childPty: PtyProcess): void {
    entry.pty = childPty;
    childPty.onData((data) => {
      if (entry.pty !== childPty) return;
      const prevCwd = entry.session.cwd;
      const nextCwd = extractTerminalCwd(data, entry.session.hostId, currentPlatform);
      if (nextCwd && nextCwd !== prevCwd) {
        entry.session.cwd = nextCwd;
      }
      appendScrollback(entry, data);
      if (persistScrollback || entry.session.cwd !== prevCwd) {
        schedulePersist(entry);
      }
      enqueuePtyOutput(entry, data);
    });

    childPty.onExit(({ exitCode }) => {
      if (entry.pty !== childPty) return;
      flushPendingOutput(entry);
      resetFlowControl(entry);
      entry.pty = null;
      entry.modeState = createTerminalModeState();
      entry.scrollbackBaseAltScreen = null;
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

  function terminatePty(activePty: PtyProcess, asyncTeardown = true): void {
    const pid = typeof activePty.pid === 'number' && Number.isInteger(activePty.pid) && activePty.pid > 0
      ? activePty.pid
      : undefined;

    const killPtyOnly = () => {
      try {
        activePty.kill();
      } catch {
        // Ignore kill errors on already-closing PTYs.
      }
    };

    if (!pid) {
      killPtyOnly();
      return;
    }

    if (!asyncTeardown) {
      if (currentPlatform === 'win32') {
        try {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 1_500,
          }, () => {});
        } catch {
          // Ignore taskkill errors during shutdown.
        }
      }
      killPtyOnly();
      return;
    }

    setImmediate(() => {
      if (currentPlatform === 'win32') {
        // Kill the entire child process tree (e.g. PowerShell + agy/claude/codex + MCP children)
        // before closing ConPTY handles, so ClosePseudoConsole does not block waiting on orphans.
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 3_000,
        }, () => {
          killPtyOnly();
        });
        return;
      }
      killPtyOnly();
    });
  }

  const windowsBuild = parseWindowsBuildNumber();

  return {
    platform: currentPlatform,
    ...(windowsBuild !== undefined ? { windowsBuild } : {}),
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

      // Allow at most one open "new conversation" (without cliSessionId) per project + CLI group.
      if (normalized.preset !== 'shell' && !normalized.cliSessionId) {
        const existingNew = Array.from(terminals.values()).find((entry) => (
          entry.session.projectId === project.id
          && entry.session.preset === normalized.preset
          && !entry.session.cliSessionId
        ));
        if (existingNew) {
          return { ...existingNew.session };
        }
      }

      const launchCommand = resolveWorkTerminalCommand(project, normalized.preset, normalized.command);
      const spawned = await spawnTerminalPty({
        projectId: project.id,
        hostId: project.hostId,
        targetCwd: project.directory,
        fallbackProjectCwd: project.directory,
        proxyUrl: resolveWorkTerminalProxyUrl(project, normalized.preset),
        preset: normalized.preset,
        shell: normalized.shell,
        command: launchCommand,
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
        ...(normalized.cliSessionId ? { cliSessionId: normalized.cliSessionId } : {}),
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
        scrollbackChunks: [],
        scrollbackLength: 0,
        modeState: createTerminalModeState(),
        scrollbackBaseAltScreen: null,
        cols: normalized.cols,
        rows: normalized.rows,
        dirtySnapshot: false,
        flushTimer: null,
        pendingOutput: '',
        outputTimer: null,
        unackedChars: 0,
        ptyPaused: false,
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

      const launchCommand = resolveWorkTerminalCommand(project, entry.session.preset, entry.session.command);
      const spawned = await spawnTerminalPty({
        projectId: project.id,
        hostId: project.hostId,
        targetCwd: entry.session.cwd || project.directory,
        fallbackProjectCwd: project.directory,
        proxyUrl: resolveWorkTerminalProxyUrl(project, entry.session.preset),
        preset: entry.session.preset,
        shell: entry.session.shell,
        command: launchCommand,
        cols,
        rows,
        passwordOverride: rawInput.password,
        rememberPassword: rawInput.rememberPassword,
      });

      clearOutputCoalesce(entry);
      resetFlowControl(entry);
      entry.session.cwd = spawned.effectiveCwd;
      if (spawned.resolvedWindowsShell) {
        entry.session.shell = spawned.resolvedWindowsShell;
      }
      entry.session.status = 'running';
      entry.session.exitCode = null;
      entry.modeState = createTerminalModeState();
      entry.scrollbackBaseAltScreen = null;
      delete entry.session.errorMessage;
      delete entry.session.errorCode;

      const existingScrollback = materializeScrollback(entry);
      if (existingScrollback) {
        // A previously saved Codex fullscreen session can end without emitting its exit sequence.
        // Close that screen in the replay before drawing the new inline session.
        const oldAltScreen = entry.session.preset === 'codex'
          ? advanceTerminalModeState(createTerminalModeState(), existingScrollback).altScreen
          : null;
        const leaveAltScreen = oldAltScreen === null ? '' : `\x1b[?${oldAltScreen}l`;
        const prefix = existingScrollback.endsWith('\n') || existingScrollback.endsWith('\r') ? '' : '\r\n';
        const marker = `${leaveAltScreen}${prefix}\x1b[90m── 会话已恢复 · ${spawned.effectiveCwd} ──\x1b[0m\r\n`;
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
      let nextCliSessionId: string | undefined;
      let nextCommand: string | undefined;
      if (patch.cliSessionId !== undefined) {
        if (entry.session.preset === 'shell') {
          throw invalid('普通终端不支持绑定 CLI 对话标识。');
        }
        try {
          nextCliSessionId = validateCliSessionId(patch.cliSessionId);
        } catch (error) {
          throw invalid(error instanceof Error ? error.message : 'CLI 对话标识不合法。');
        }
        if (!nextCliSessionId) {
          throw invalid('CLI 对话标识不能为空。');
        }
        nextCommand = buildCliResumeCommand(entry.session.preset, nextCliSessionId);
      }
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
      if (nextCliSessionId !== undefined && nextCommand !== undefined) {
        entry.session.cliSessionId = nextCliSessionId;
        entry.session.command = nextCommand;
      }
      updateWorkTerminalMetaRow(db, INSTANCE_ID, terminalId, {
        ...(patch.title !== undefined ? { title: entry.session.title } : {}),
        ...(patch.pinned !== undefined ? { pinned: Boolean(entry.session.pinned) } : {}),
        ...(nextCliSessionId !== undefined ? { cliSessionId: nextCliSessionId, command: nextCommand } : {}),
      });
      return { ...entry.session };
    },

    attach(terminalId, listener) {
      const entry = requireEntry(terminalId);
      // Flush already-buffered bytes to existing listeners before capturing snapshot so the
      // newly attached client does not receive both snapshot bytes and duplicate live output.
      flushPendingOutput(entry);
      entry.listeners.add(listener);
      resetFlowControl(entry);
      return {
        snapshot: buildTerminalSnapshotWithModes(
          materializeScrollback(entry),
          entry.modeState,
          entry.scrollbackBaseAltScreen,
          entry.session.status === 'running',
        ),
        session: { ...entry.session },
        detach: () => {
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) {
            resetFlowControl(entry);
          }
          if (entry.dirtySnapshot) {
            flushEntryToDb(entry);
          }
        },
      };
    },

    ack(terminalId, chars) {
      const entry = terminals.get(terminalId);
      if (!entry || !Number.isFinite(chars) || chars <= 0) return;
      entry.unackedChars = Math.max(0, entry.unackedChars - Math.floor(chars));
      if (entry.ptyPaused && entry.unackedChars <= FLOW_CONTROL_LOW_WATERMARK) {
        entry.ptyPaused = false;
        try {
          entry.pty?.resume?.();
        } catch {
          // Ignore resume errors on closed PTY.
        }
      }
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
      if (entry.cols === nextCols && entry.rows === nextRows) return;
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
      clearOutputCoalesce(entry);
      terminals.delete(terminalId);
      const activePty = entry.pty;
      entry.pty = null;
      if (entry.session.status === 'running' && activePty) {
        entry.session.status = 'exited';
        terminatePty(activePty, true);
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
        clearOutputCoalesce(entry);
        terminals.delete(entry.session.id);
        const activePty = entry.pty;
        entry.pty = null;
        if (entry.session.status === 'running' && activePty) {
          entry.session.status = 'exited';
          terminatePty(activePty, true);
        }
        entry.listeners.clear();
      }
    },

    setPersistScrollback(enabled) {
      const next = Boolean(enabled);
      persistScrollback = next;
      if (!next) {
        for (const entry of terminals.values()) {
          entry.dirtySnapshot = false;
          if (entry.flushTimer) {
            clearTimeout(entry.flushTimer);
            entry.flushTimer = null;
          }
        }
        try {
          clearWorkTerminalScrollbacks(db, INSTANCE_ID);
        } catch {
          // Ignore cleanup errors if settings update races teardown.
        }
        return;
      }
      for (const entry of terminals.values()) {
        if (entry.scrollbackLength > 0) {
          schedulePersist(entry);
        }
      }
    },

    disposeAll() {
      for (const entry of terminals.values()) {
        if (entry.flushTimer) {
          clearTimeout(entry.flushTimer);
          entry.flushTimer = null;
        }
        clearOutputCoalesce(entry);
        const persistStatus = entry.session.status === 'running' ? 'restored' : entry.session.status;
        flushEntryToDb(entry, persistStatus);
        const activePty = entry.pty;
        entry.pty = null;
        if (entry.session.status === 'running' && activePty) {
          entry.session.status = 'restored';
          terminatePty(activePty, false);
        }
        entry.listeners.clear();
      }
      terminals.clear();
    },
  };
}
