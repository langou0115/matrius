/**
 * Shared types and pure helpers for desktop work terminals and WebSocket I/O.
 * Keep this module free of Node, DOM, React and SQLite imports.
 */

import { validateCliSessionId } from './work-cli';

export type WorkTerminalPreset = 'shell' | 'claude' | 'codex' | 'antigravity';
export type WorkTerminalStatus = 'running' | 'restored' | 'exited' | 'error';
export type WindowsTerminalShell = 'powershell' | 'cmd';

export const DEFAULT_WINDOWS_SHELL: WindowsTerminalShell = 'powershell';

export const WINDOWS_SHELL_OPTIONS: ReadonlyArray<{
  id: WindowsTerminalShell;
  label: string;
}> = [
  { id: 'powershell', label: 'PowerShell' },
  { id: 'cmd', label: 'CMD' },
];

export type WorkTerminalSession = {
  id: string;
  projectId: string;
  hostId: string;
  title: string;
  preset: WorkTerminalPreset;
  shell?: WindowsTerminalShell;
  cliSessionId?: string;
  command: string;
  cwd: string;
  status: WorkTerminalStatus;
  exitCode: number | null;
  errorMessage?: string;
  errorCode?: string;
  pinned?: boolean;
  createdAt: number;
};

export type WorkTerminalResumeInput = {
  cols?: number;
  rows?: number;
  password?: string;
  rememberPassword?: boolean;
};

export type WorkTerminalPatchInput = {
  title?: string;
  pinned?: boolean;
};

export type WorkTerminalCreateInput = {
  projectId: string;
  preset?: WorkTerminalPreset;
  shell?: WindowsTerminalShell;
  cliSessionId?: string;
  title?: string;
  command?: string;
  cols?: number;
  rows?: number;
};

export type NormalizedWorkTerminalInput = {
  projectId: string;
  preset: WorkTerminalPreset;
  shell?: WindowsTerminalShell;
  cliSessionId?: string;
  title: string;
  command: string;
  cols: number;
  rows: number;
};

export type WorkTerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type WorkTerminalServerMessage =
  | { type: 'snapshot'; data: string }
  | { type: 'output'; data: string }
  | { type: 'status'; status: WorkTerminalStatus; exitCode: number | null; message?: string };

export const WORK_TERMINAL_PRESETS: ReadonlyArray<{
  id: WorkTerminalPreset;
  label: string;
  defaultCommand: string;
}> = [
  { id: 'shell', label: '终端', defaultCommand: '' },
  { id: 'claude', label: 'Claude Code', defaultCommand: 'claude' },
  { id: 'codex', label: 'Codex', defaultCommand: 'codex' },
  { id: 'antigravity', label: 'Antigravity', defaultCommand: 'agy' },
];

function hasControlChars(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeTerminalPreset(raw: string | undefined): WorkTerminalPreset {
  if (raw === 'claude' || raw === 'codex' || raw === 'antigravity') return raw;
  return 'shell';
}

export function defaultTerminalCommand(preset: WorkTerminalPreset): string {
  return WORK_TERMINAL_PRESETS.find((item) => item.id === preset)?.defaultCommand ?? '';
}

export function normalizeWindowsShell(raw: unknown): WindowsTerminalShell {
  return raw === 'cmd' ? 'cmd' : 'powershell';
}

export function normalizeOptionalWindowsShell(raw: unknown): WindowsTerminalShell | undefined {
  if (raw === 'powershell' || raw === 'cmd') return raw;
  return undefined;
}

export function defaultTerminalTitle(
  preset: WorkTerminalPreset,
  existingCount = 0,
  shell?: WindowsTerminalShell,
): string {
  const base = preset === 'shell' && shell
    ? (WINDOWS_SHELL_OPTIONS.find((item) => item.id === shell)?.label ?? '终端')
    : (WORK_TERMINAL_PRESETS.find((item) => item.id === preset)?.label ?? '终端');
  return existingCount > 0 ? `${base} ${existingCount + 1}` : base;
}

export function clampTerminalCols(cols: number | undefined): number {
  const numeric = typeof cols === 'number' && Number.isFinite(cols) ? Math.floor(cols) : 100;
  return Math.max(20, Math.min(400, numeric));
}

export function clampTerminalRows(rows: number | undefined): number {
  const numeric = typeof rows === 'number' && Number.isFinite(rows) ? Math.floor(rows) : 30;
  return Math.max(6, Math.min(200, numeric));
}

export function normalizeWorkTerminalTitle(raw: string): string {
  const title = raw.trim();
  if (!title) throw new Error('终端名称不能为空。');
  if (hasControlChars(title)) throw new Error('终端名称不能包含控制字符。');
  if (title.length > 80) throw new Error('终端名称不能超过 80 个字符。');
  return title;
}

export function validateWorkTerminalInput(
  raw: WorkTerminalCreateInput,
  existingCount = 0,
): NormalizedWorkTerminalInput {
  const projectId = (raw.projectId ?? '').trim();
  if (!projectId) throw new Error('请先选择项目。');
  if (hasControlChars(projectId)) throw new Error('项目标识不合法。');

  const preset = normalizeTerminalPreset(raw.preset);
  const shell = preset === 'shell' ? normalizeOptionalWindowsShell(raw.shell) : undefined;
  const cliSessionId = preset === 'shell' ? undefined : validateCliSessionId(raw.cliSessionId);
  const title = (raw.title ?? '').trim();
  if (hasControlChars(title)) throw new Error('终端名称不能包含控制字符。');
  if (title.length > 80) throw new Error('终端名称不能超过 80 个字符。');

  const rawCommand = raw.command !== undefined ? raw.command.trim() : defaultTerminalCommand(preset);
  if (hasControlChars(rawCommand)) throw new Error('启动命令不能包含控制字符。');
  if (rawCommand.length > 500) throw new Error('启动命令不能超过 500 个字符。');

  return {
    projectId,
    preset,
    ...(shell ? { shell } : {}),
    ...(cliSessionId ? { cliSessionId } : {}),
    title: title || defaultTerminalTitle(preset, existingCount, shell),
    command: rawCommand,
    cols: clampTerminalCols(raw.cols),
    rows: clampTerminalRows(raw.rows),
  };
}

// ConPTY frequently emits `\x1b[3J...\r\n\x1b[H` when `clear`/`cls` runs near the bottom
// row. The transient `\r\n` before cursor-home pushes a stale/blank row back into scrollback
// immediately after ED 3 cleared it, so strip only that pre-home newline.
const ANSI_ESC = '\x1b';
const CONPTY_CLEAR_NEWLINE_BEFORE_HOME_RE = new RegExp(
  `(${ANSI_ESC}\\[3J(?:${ANSI_ESC}\\[[0-9;?]*[mlhK])*)(?:\\r?\\n)+(?=${ANSI_ESC}\\[(?:1;1|1;|;1|;)?H)`,
  'gu',
);

export function normalizeConptyClearChunk(chunk: string): string {
  if (!chunk.includes('\x1b[3J')) return chunk;
  return chunk.replace(CONPTY_CLEAR_NEWLINE_BEFORE_HOME_RE, '$1');
}

export function trimScrollbackAtEraseSavedLines(scrollback: string): string {
  const lastClearIndex = scrollback.lastIndexOf('\x1b[3J');
  const sliced = lastClearIndex >= 0 ? scrollback.slice(lastClearIndex) : scrollback;
  return normalizeConptyClearChunk(sliced);
}
