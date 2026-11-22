/**
 * Shared types and pure helpers for desktop work terminals and WebSocket I/O.
 * Keep this module free of Node, DOM, React and SQLite imports.
 */

import { NEW_CLI_SESSION_TITLE, validateCliSessionId } from './work-cli';

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
  cliSessionId?: string;
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

export function normalizeWorkTerminalOrder(raw: readonly unknown[] | undefined): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 120 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.slice(0, 500);
}

export function sortWorkTerminalsByOrder(
  terminals: readonly WorkTerminalSession[],
  terminalOrder: readonly string[] = [],
): WorkTerminalSession[] {
  let baseOrdered: WorkTerminalSession[];
  if (terminals.length <= 1 || terminalOrder.length === 0) {
    baseOrdered = [...terminals];
  } else {
    const orderIndex = new Map(terminalOrder.map((id, index) => [id, index]));
    const known: Array<{ item: WorkTerminalSession; order: number }> = [];
    const trailing: WorkTerminalSession[] = [];
    for (const item of terminals) {
      const idx = orderIndex.get(item.id);
      if (idx === undefined) trailing.push(item);
      else known.push({ item, order: idx });
    }
    known.sort((left, right) => left.order - right.order);
    baseOrdered = [...known.map((entry) => entry.item), ...trailing];
  }

  const pinned: WorkTerminalSession[] = [];
  const unpinned: WorkTerminalSession[] = [];
  for (const item of baseOrdered) {
    if (item.pinned) pinned.push(item);
    else unpinned.push(item);
  }
  return [...pinned, ...unpinned];
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
    title: title || (preset !== 'shell' && !cliSessionId ? NEW_CLI_SESSION_TITLE : defaultTerminalTitle(preset, existingCount, shell)),
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

export type WorkTerminalMouseProtocol = 9 | 1000 | 1002 | 1003;
export type WorkTerminalMouseEncoding = 1006 | 1016;
export type WorkTerminalAltScreenMode = 47 | 1047 | 1049;

export type WorkTerminalModeState = {
  mouseProtocol: WorkTerminalMouseProtocol | null;
  mouseEncoding: WorkTerminalMouseEncoding | null;
  focusEvents: boolean;
  bracketedPaste: boolean;
  applicationCursorKeys: boolean;
  applicationKeypad: boolean;
  cursorHidden: boolean;
  altScreen: WorkTerminalAltScreenMode | null;
  pendingEscape: string;
};

export function createTerminalModeState(
  initial: Partial<WorkTerminalModeState> = {},
): WorkTerminalModeState {
  return {
    mouseProtocol: initial.mouseProtocol ?? null,
    mouseEncoding: initial.mouseEncoding ?? null,
    focusEvents: Boolean(initial.focusEvents),
    bracketedPaste: Boolean(initial.bracketedPaste),
    applicationCursorKeys: Boolean(initial.applicationCursorKeys),
    applicationKeypad: Boolean(initial.applicationKeypad),
    cursorHidden: Boolean(initial.cursorHidden),
    altScreen: initial.altScreen ?? null,
    pendingEscape: initial.pendingEscape ?? '',
  };
}

function resetSoftModes(state: WorkTerminalModeState): void {
  state.focusEvents = false;
  state.bracketedPaste = false;
  state.applicationCursorKeys = false;
  state.applicationKeypad = false;
  state.cursorHidden = false;
}

function resetAllModes(state: WorkTerminalModeState): void {
  state.mouseProtocol = null;
  state.mouseEncoding = null;
  state.altScreen = null;
  resetSoftModes(state);
}

function applyDecPrivateMode(state: WorkTerminalModeState, code: number, enabled: boolean): void {
  switch (code) {
    case 1:
      state.applicationCursorKeys = enabled;
      break;
    case 9:
    case 1000:
    case 1002:
    case 1003:
      state.mouseProtocol = enabled ? code : null;
      break;
    case 25:
      state.cursorHidden = !enabled;
      break;
    case 47:
    case 1047:
    case 1049:
      state.altScreen = enabled ? code : null;
      break;
    case 66:
      state.applicationKeypad = enabled;
      break;
    case 1004:
      state.focusEvents = enabled;
      break;
    case 1006:
    case 1016:
      state.mouseEncoding = enabled ? code : null;
      break;
    case 2004:
      state.bracketedPaste = enabled;
      break;
    default:
      break;
  }
}

const MAX_PENDING_ESCAPE_CHARS = 64;

/**
 * Scan PTY output sequentially to track active DEC private modes (mouse tracking,
 * SGR coordinates, focus reporting, bracketed paste, app cursor/keypad, alt buffer)
 * so snapshot replays after scrollback truncation preserve interactive TUI mouse clicks.
 */
export function advanceTerminalModeState(
  state: WorkTerminalModeState,
  chunk: string,
): WorkTerminalModeState {
  if (!chunk && !state.pendingEscape) return state;
  const next = createTerminalModeState({ ...state, pendingEscape: '' });
  const input = state.pendingEscape ? `${state.pendingEscape}${chunk}` : chunk;
  const len = input.length;
  let index = 0;

  while (index < len) {
    const escIndex = input.indexOf('\x1b', index);
    if (escIndex === -1) break;
    if (escIndex + 1 >= len) {
      next.pendingEscape = input.slice(escIndex);
      break;
    }

    const intro = input[escIndex + 1];
    if (intro === 'c') {
      resetAllModes(next);
      index = escIndex + 2;
      continue;
    }

    if (intro !== '[') {
      index = escIndex + 2;
      continue;
    }

    let cursor = escIndex + 2;
    let finalChar = '';
    while (cursor < len) {
      const code = input.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) {
        finalChar = input[cursor];
        break;
      }
      // Control characters or unexpectedly long sequences abort this CSI scan.
      if (code < 0x20 || cursor - escIndex > MAX_PENDING_ESCAPE_CHARS) {
        break;
      }
      cursor += 1;
    }

    if (!finalChar) {
      if (cursor >= len && len - escIndex <= MAX_PENDING_ESCAPE_CHARS) {
        next.pendingEscape = input.slice(escIndex);
        break;
      }
      index = escIndex + 2;
      continue;
    }

    const body = input.slice(escIndex + 2, cursor);
    if (body === '!' && finalChar === 'p') {
      resetSoftModes(next);
    } else if (body.startsWith('?') && (finalChar === 'h' || finalChar === 'l')) {
      const enabled = finalChar === 'h';
      const paramStr = body.slice(1);
      if (/^[0-9;]*$/u.test(paramStr)) {
        const parts = paramStr ? paramStr.split(';') : ['0'];
        for (const rawPart of parts) {
          const code = rawPart ? Number.parseInt(rawPart, 10) : 0;
          if (Number.isFinite(code)) {
            applyDecPrivateMode(next, code, enabled);
          }
        }
      }
    }

    index = cursor + 1;
  }

  return next;
}

export function formatTerminalModeRestoreSuffix(state: WorkTerminalModeState): string {
  const enableCodes: number[] = [];
  if (state.applicationCursorKeys) enableCodes.push(1);
  if (state.applicationKeypad) enableCodes.push(66);
  if (state.mouseProtocol !== null) enableCodes.push(state.mouseProtocol);
  if (state.focusEvents) enableCodes.push(1004);
  if (state.mouseEncoding !== null) enableCodes.push(state.mouseEncoding);
  if (state.bracketedPaste) enableCodes.push(2004);

  return enableCodes.length > 0 ? `\x1b[?${enableCodes.join(';')}h` : '';
}

export function buildTerminalSnapshotWithModes(
  scrollback: string,
  state: WorkTerminalModeState,
  leadingAltScreen: WorkTerminalAltScreenMode | null,
  isRunning: boolean,
): string {
  if (!isRunning) return scrollback;
  const prefix = leadingAltScreen !== null ? `\x1b[?${leadingAltScreen}h` : '';
  const suffix = formatTerminalModeRestoreSuffix(state);
  if (!prefix && !suffix) return scrollback;
  return `${prefix}${scrollback}${suffix}`;
}
