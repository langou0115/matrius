import { LOCAL_WORK_HOST_ID } from '@contract/work-projects';
import {
  normalizeConptyClearChunk,
  type WorkTerminalSession,
} from '@contract/work-terminals';
import { ArrowDown, ClipboardPaste, Copy, RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { copyText } from '@/core/platform/clipboard';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { deleteWorkTerminal, resumeWorkTerminal, workTerminalWsUrl } from './work-api';
import { connectWorkTerminal, type TerminalConnectionStatus } from './work-terminal-connection';
import {
  bumpCliSessionsRefresh,
  bumpHostUnlockVersion,
  detectPreviewPlatform,
  removeWorkTerminal,
  replaceWorkTerminalSession,
  updateWorkTerminalStatus,
  useWorkState,
} from './work-state';

type XtermInstance = import('@xterm/xterm').Terminal;
type XtermLink = import('@xterm/xterm').ILink;
type XtermTheme = import('@xterm/xterm').ITheme;
type XtermWindowsPty = import('@xterm/xterm').IWindowsPty;
type FitAddonInstance = import('@xterm/addon-fit').FitAddon;

const TERMINAL_HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/gu;
const TRAILING_URL_PUNCTUATION_RE = /[.,;:!?)}\]>'"]+$/u;

function stripTrailingControlChars(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return text.slice(0, index);
    }
  }
  return text;
}

export function openTerminalExternalLink(
  uri: string,
  openFn: (url: string, target: string, features: string) => unknown = (url, target, features) =>
    window.open(url, target, features),
): boolean {
  try {
    const parsed = new URL(uri.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    openFn(parsed.href, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
}

function registerTerminalUrlLinkProvider(terminal: XtermInstance): { dispose(): void } {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      if (!text.includes('http://') && !text.includes('https://')) {
        callback(undefined);
        return;
      }
      const directClick = terminal.modes.mouseTrackingMode === 'none';
      const links: XtermLink[] = [];
      TERMINAL_HTTP_URL_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = TERMINAL_HTTP_URL_RE.exec(text)) !== null) {
        const cleaned = stripTrailingControlChars(match[0]).replace(TRAILING_URL_PUNCTUATION_RE, '');
        if (!cleaned) continue;
        const startX = match.index + 1;
        const endX = match.index + cleaned.length;
        links.push({
          range: {
            start: { x: startX, y: bufferLineNumber },
            end: { x: endX, y: bufferLineNumber },
          },
          text: cleaned,
          decorations: {
            pointerCursor: directClick,
            underline: directClick,
          },
          activate(event, linkText) {
            if (terminal.modes.mouseTrackingMode !== 'none' && !event.ctrlKey && !event.metaKey) {
              return;
            }
            openTerminalExternalLink(linkText);
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  });
}

function resolveWindowsPty(
  hostId: string,
  serverPlatform: string | null,
  windowsBuild: number | null,
  preview: boolean,
): XtermWindowsPty | undefined {
  if (hostId !== LOCAL_WORK_HOST_ID) return undefined;
  const platform = preview ? (serverPlatform ?? detectPreviewPlatform()) : serverPlatform;
  if (platform !== 'win32') return undefined;
  return { backend: 'conpty', buildNumber: windowsBuild ?? 22631 };
}

function readColorMode(): 'light' | 'dark' {
  const root = document.querySelector<HTMLElement>('.matrius-app');
  return root?.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
}

function readCssColor(name: string, fallback: string): string {
  const root = document.querySelector<HTMLElement>('.matrius-app') ?? document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  return value || fallback;
}

function buildTerminalTheme(): XtermTheme {
  const mode = readColorMode();
  if (mode === 'dark') {
    const background = readCssColor('--background', '#131519');
    const foreground = readCssColor('--foreground', '#e6e8ec');
    return {
      background,
      foreground,
      cursor: foreground,
      cursorAccent: background,
      selectionBackground: 'rgba(122, 162, 247, 0.28)',
      scrollbarSliderBackground: 'rgba(230, 232, 236, 0.16)',
      scrollbarSliderHoverBackground: 'rgba(230, 232, 236, 0.28)',
      scrollbarSliderActiveBackground: 'rgba(230, 232, 236, 0.42)',
      black: '#1e2028',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#bb9af7',
      cyan: '#7dcfff',
      white: '#c0caf5',
      brightBlack: '#565f89',
      brightRed: '#ff899d',
      brightGreen: '#b9f27c',
      brightYellow: '#ff9e64',
      brightBlue: '#89b4fa',
      brightMagenta: '#cba6f7',
      brightCyan: '#89dceb',
      brightWhite: '#e6e8ec',
    };
  }
  const background = readCssColor('--background', '#ffffff');
  const foreground = readCssColor('--foreground', '#1f2328');
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: 'rgba(22, 119, 255, 0.16)',
    scrollbarSliderBackground: 'rgba(31, 35, 40, 0.16)',
    scrollbarSliderHoverBackground: 'rgba(31, 35, 40, 0.28)',
    scrollbarSliderActiveBackground: 'rgba(31, 35, 40, 0.42)',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#bf8700',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#1f2328',
  };
}

function canMountXterm(): boolean {
  return typeof window !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof requestAnimationFrame === 'function'
    && 'ResizeObserver' in globalThis;
}

const TERMINAL_FONT_SIZE = 14;
const TERMINAL_FONT_FAMILY = "'JetBrainsMono', 'Cascadia Mono', Consolas, 'Noto Sans Mono CJK SC', 'Microsoft YaHei Mono', ui-monospace, SFMono-Regular, Menlo, 'NotoSansSC', monospace";
const TERMINAL_WRITE_BATCH_MAX_CHARS = 64_000;
const TERMINAL_ACK_BATCH_CHARS = 5_000;
const TERMINAL_RESIZE_SETTLE_MS = 90;
export const TERMINAL_CONTEXT_MENU_WIDTH = 160;
export const TERMINAL_CONTEXT_MENU_HEIGHT = 96;

export function clampTerminalContextMenuPosition(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = TERMINAL_CONTEXT_MENU_WIDTH,
  menuHeight = TERMINAL_CONTEXT_MENU_HEIGHT,
): { left: number; top: number } {
  const padding = 12;
  const maxLeft = Math.max(padding, viewportWidth - menuWidth - padding);
  const maxTop = Math.max(padding, viewportHeight - menuHeight - padding);
  return {
    left: Math.max(padding, Math.min(clientX, maxLeft)),
    top: Math.max(padding, Math.min(clientY, maxTop)),
  };
}

export function sliceTerminalWriteBatch(
  buffer: string,
  maxChars = TERMINAL_WRITE_BATCH_MAX_CHARS,
): { chunk: string; rest: string } {
  if (buffer.length <= maxChars) {
    return { chunk: buffer, rest: '' };
  }
  let end = maxChars;
  // Keep DEC ?2026 synchronized output blocks together when the closing sequence falls
  // inside a bounded lookahead so full-screen repaints do not tear mid-frame.
  const lastSyncOpen = buffer.lastIndexOf('\x1b[?2026h', end - 1);
  if (lastSyncOpen >= 0) {
    const syncCloseBefore = buffer.indexOf('\x1b[?2026l', lastSyncOpen);
    if (syncCloseBefore < 0 || syncCloseBefore >= end) {
      const nextSyncClose = buffer.indexOf('\x1b[?2026l', end);
      if (nextSyncClose >= 0 && nextSyncClose - end <= 64_000) {
        end = nextSyncClose + '\x1b[?2026l'.length;
        return {
          chunk: buffer.slice(0, end),
          rest: buffer.slice(end),
        };
      }
      if (lastSyncOpen > 0) {
        end = lastSyncOpen;
      }
    }
  }
  // Avoid cutting inside a UTF-16 surrogate pair.
  const prevCode = buffer.charCodeAt(end - 1);
  if (prevCode >= 0xd800 && prevCode <= 0xdbff && end > 1) {
    end -= 1;
  }
  // Avoid splitting a trailing incomplete CSI/OSC/ESC control sequence across batches.
  const scanStart = Math.max(0, end - 64);
  const escIndex = buffer.lastIndexOf('\x1b', end - 1);
  if (escIndex >= scanStart && escIndex > 0) {
    const tail = buffer.slice(escIndex + 1, end);
    if (
      tail.length === 0
      || (tail.startsWith('[') && !/[A-Za-z~@]$/u.test(tail))
      || (tail.startsWith(']') && !tail.includes('\x07') && !tail.endsWith('\\'))
    ) {
      end = escIndex;
    }
  }
  if (end <= 0) end = maxChars;
  return {
    chunk: buffer.slice(0, end),
    rest: buffer.slice(end),
  };
}

export function waitsForTerminalRepaint(chunk: string): boolean {
  // Hold only a clear with no replacement text yet. Output that is already a
  // complete repaint, including DEC synchronized output, takes the normal path.
  // eslint-disable-next-line no-control-regex
  return /(?:\x1b\[[23]J|\x1b\[(?:1;1)?H\x1b\[0?J)(?:\x1b\[[0-?]*[ -/]*[@-~]|[ \r\n\t])*$/u.test(chunk.slice(-256));
}

export function syncHelperTextareaGeometry(options: {
  container: HTMLElement;
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
  compositionAnchor?: { x: number; y: number } | null;
  isComposing?: boolean;
}): void {
  const {
    container,
    cursor,
    cols,
    rows,
    compositionAnchor = null,
    isComposing = false,
  } = options;
  if (!isComposing) container.removeAttribute('data-ime-composing');
  const textarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
  const screenElement = container.querySelector<HTMLElement>('.xterm-screen');
  if (!textarea || !screenElement) return;
  const screenWidth = screenElement.clientWidth;
  const screenHeight = screenElement.clientHeight;
  const safeCols = Math.max(1, cols);
  const safeRows = Math.max(1, rows);
  const cellWidth = screenWidth / safeCols;
  const cellHeight = screenHeight / safeRows;
  if (!(cellWidth > 0 && cellHeight > 0)) return;

  const anchor = isComposing && compositionAnchor ? compositionAnchor : cursor;
  const col = Math.min(Math.max(anchor.x, 0), safeCols - 1);
  const row = Math.min(Math.max(anchor.y, 0), safeRows - 1);
  const boxWidth = Math.max(cellWidth, 2);
  const boxHeight = Math.max(cellHeight, 2);
  const left = Math.min(col * cellWidth, Math.max(0, screenWidth - boxWidth));
  const top = Math.min(row * cellHeight, Math.max(0, screenHeight - boxHeight));

  const compositionView = container.querySelector<HTMLElement>('.composition-view.active');
  const viewWidth = isComposing ? compositionView?.getBoundingClientRect().width ?? 0 : 0;
  const clampedLeft = Math.min(left, Math.max(0, screenWidth - viewWidth));
  if (isComposing) {
    // xterm also sets inline geometry after rendering, including in a deferred
    // callback. Keep both CSS vars and textarea coordinates aligned so the OS
    // IME candidate window and xterm's composition preview follow the cursor.
    container.style.setProperty('--work-ime-left', `${clampedLeft}px`);
    container.style.setProperty('--work-ime-top', `${top}px`);
    container.style.setProperty('--work-ime-width', `${Math.max(viewWidth, boxWidth)}px`);
    container.style.setProperty('--work-ime-height', `${boxHeight}px`);
    container.setAttribute('data-ime-composing', '');
    textarea.style.left = `${clampedLeft}px`;
    textarea.style.top = `${top}px`;
    textarea.style.width = `${Math.max(viewWidth, boxWidth)}px`;
    textarea.style.height = `${boxHeight}px`;
    return;
  }
  textarea.style.left = `${left}px`;
  textarea.style.top = `${top}px`;
  textarea.style.width = `${boxWidth}px`;
  textarea.style.height = `${boxHeight}px`;
  textarea.style.lineHeight = `${boxHeight}px`;
  textarea.style.fontSize = `${TERMINAL_FONT_SIZE}px`;
  textarea.style.zIndex = '-5';
}

export type TerminalClipboardTarget = {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  focus(): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
};

/** Bind right-click menu or fallback copy on selection, plus Ctrl+C copy and native Ctrl+V paste. */
export function attachTerminalClipboard(options: {
  terminal: TerminalClipboardTarget;
  container: HTMLElement;
  sendInterrupt: () => void;
  copyTextFn?: (text: string) => Promise<void>;
  onOpenContextMenu?: (event: MouseEvent) => void;
  isDisposed?: () => boolean;
}): () => void {
  const {
    terminal,
    container,
    sendInterrupt,
    copyTextFn = copyText,
    onOpenContextMenu,
    isDisposed = () => false,
  } = options;

  const copySelection = (): boolean => {
    if (!terminal.hasSelection()) return false;
    const selected = terminal.getSelection();
    if (!selected) return false;
    try {
      void Promise.resolve(copyTextFn(selected))
        .catch(() => {})
        .finally(() => {
          if (!isDisposed()) terminal.focus();
        });
    } catch {
      // Clipboard APIs may be unavailable in restricted contexts.
    }
    terminal.clearSelection();
    return true;
  };

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const key = (event.key ?? '').toLowerCase();
    const isCopyKey = event.code === 'KeyC' || key === 'c';
    const isPasteKey = event.code === 'KeyV' || key === 'v';

    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isCopyKey) {
      if (copySelection()) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      if (event.isComposing || event.keyCode === 229) {
        event.preventDefault();
        sendInterrupt();
        return false;
      }
      return true;
    }

    if (
      isCopyKey
      && (
        (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey)
        || (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
      )
    ) {
      if (copySelection()) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }
      return true;
    }

    // Returning false without preventDefault lets the browser fire its native paste
    // event onto xterm's focused textarea (avoiding permission prompts and \x16).
    if (
      isPasteKey
      && !event.altKey
      && ((event.ctrlKey && !event.metaKey) || (event.metaKey && !event.ctrlKey && !event.shiftKey))
    ) {
      return false;
    }

    return true;
  });

  const handleContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    if (onOpenContextMenu) {
      event.preventDefault();
      event.stopPropagation();
      onOpenContextMenu(event);
      return;
    }
    if (!copySelection()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleMouseDownCapture = (event: MouseEvent) => {
    // Prevent xterm's right-click helper displacement (which relocates the hidden
    // textarea to mouse coordinates and breaks subsequent IME candidate positioning).
    if (onOpenContextMenu && event.button === 2) {
      event.stopPropagation();
    }
  };

  container.addEventListener('contextmenu', handleContextMenu, { capture: true });
  if (onOpenContextMenu) {
    container.addEventListener('mousedown', handleMouseDownCapture, { capture: true });
  }
  return () => {
    container.removeEventListener('contextmenu', handleContextMenu, { capture: true });
    if (onOpenContextMenu) {
      container.removeEventListener('mousedown', handleMouseDownCapture, { capture: true });
    }
  };
}

function WorkTerminalPane({
  session,
  active,
}: {
  session: WorkTerminalSession;
  active: boolean;
}) {
  const instance = useInstance();
  const preview = useIsPreview();
  const { hosts, hostUnlockVersion, serverPlatform, windowsBuild } = useWorkState();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XtermInstance | null>(null);
  const fitRef = useRef<FitAddonInstance | null>(null);
  const retryConnectionRef = useRef<(() => void) | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<TerminalConnectionStatus>('connecting');
  const activeRef = useRef(active);
  const windowsPty = resolveWindowsPty(session.hostId, serverPlatform, windowsBuild, preview);
  const windowsPtyRef = useRef(windowsPty);
  const autoResumedRef = useRef<string | null>(null);
  const lastUnlockRef = useRef(hostUnlockVersion);
  const [restarting, setRestarting] = useState(false);
  const [sshPassword, setSshPassword] = useState('');
  const [rememberPassword, setRememberPassword] = useState(false);

  const sessionHost = session.hostId !== LOCAL_WORK_HOST_ID
    ? hosts.find((item) => item.id === session.hostId) ?? null
    : null;
  const isSshSession = session.hostId !== LOCAL_WORK_HOST_ID && sessionHost?.kind !== 'wsl';
  const menuRef = useRef<HTMLDivElement>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });
  const fitFnRef = useRef<(() => void) | null>(null);
  const syncTextareaRef = useRef<(() => void) | null>(null);
  const clipboardHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    left: number;
    top: number;
    hasSelection: boolean;
  } | null>(null);
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);

  const showClipboardHint = useCallback((message: string) => {
    setClipboardHint(message);
    if (clipboardHintTimerRef.current !== null) {
      clearTimeout(clipboardHintTimerRef.current);
    }
    clipboardHintTimerRef.current = setTimeout(() => {
      clipboardHintTimerRef.current = null;
      setClipboardHint(null);
    }, 2_200);
  }, []);

  useEffect(() => () => {
    if (clipboardHintTimerRef.current !== null) {
      clearTimeout(clipboardHintTimerRef.current);
      clipboardHintTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    windowsPtyRef.current = windowsPty;
    if (termRef.current) {
      termRef.current.options.windowsPty = windowsPty ?? {};
    }
  }, [windowsPty]);

  const previewCwdRef = useRef(session.cwd);
  const previewCommandRef = useRef(session.command);
  const presetRef = useRef(session.preset);

  useEffect(() => {
    previewCwdRef.current = session.cwd;
    previewCommandRef.current = session.command;
    presetRef.current = session.preset;
  }, [session.command, session.cwd, session.preset]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canMountXterm()) return;

    let disposed = false;
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    let restoreScrollFrame: number | undefined;
    let outputFlushId: number | ReturnType<typeof setTimeout> | null = null;
    let outputFlushKind: 'raf' | 'timer' | null = null;
    let pendingOutputBuffer = '';
    let snapshotVersion = 0;
    let replayingSnapshot = false;
    let connection: ReturnType<typeof connectWorkTerminal> | undefined;
    let observer: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;
    let cliRefreshShortTimer: ReturnType<typeof setTimeout> | null = null;
    let cliRefreshFollowupTimer: ReturnType<typeof setTimeout> | null = null;
    let imeAnchorRaf = 0;
    const scheduleCliRefreshOnSubmit = (data: string) => {
      if (presetRef.current === 'shell') return;
      const triggersTurnChange = data.includes('\r') || data.includes('\n') || data.includes('\x03') || data.includes('\x1b');
      if (!triggersTurnChange) return;
      if (cliRefreshShortTimer !== null) clearTimeout(cliRefreshShortTimer);
      if (cliRefreshFollowupTimer !== null) clearTimeout(cliRefreshFollowupTimer);
      cliRefreshShortTimer = setTimeout(() => {
        cliRefreshShortTimer = null;
        bumpCliSessionsRefresh();
      }, 650);
      cliRefreshFollowupTimer = setTimeout(() => {
        cliRefreshFollowupTimer = null;
        bumpCliSessionsRefresh();
      }, 2_200);
    };
    let clipboardCleanup: (() => void) | null = null;
    const imeCleanupFns: Array<() => void> = [];
    const xtermDisposables: Array<{ dispose(): void }> = [];
    let previewLine = '';

    void (async () => {
      const [{ Terminal }, { FitAddon }, { Unicode11Addon }, webglModule] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/addon-unicode11'),
        import('@xterm/addon-webgl').catch(() => null),
      ]);
      if (disposed) return;

      const fitAddon = new FitAddon();
      const unicode11Addon = new Unicode11Addon();
      const term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 1,
        cursorInactiveStyle: 'none',
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: TERMINAL_FONT_SIZE,
        lineHeight: 1.15,
        letterSpacing: 0,
        customGlyphs: true,
        rescaleOverlappingGlyphs: false,
        scrollback: 10_000,
        scrollSensitivity: 1,
        fastScrollSensitivity: 5,
        smoothScrollDuration: 0,
        scrollOnEraseInDisplay: false,
        scrollOnUserInput: true,
        allowTransparency: false,
        theme: buildTerminalTheme(),
        linkHandler: {
          activate(_event, text) {
            openTerminalExternalLink(text);
          },
        },
        ...(windowsPtyRef.current ? { windowsPty: windowsPtyRef.current } : {}),
      });
      term.loadAddon(fitAddon);
      term.loadAddon(unicode11Addon);
      term.unicode.activeVersion = '11';
      term.open(container);
      let webglAddon: InstanceType<NonNullable<typeof webglModule>['WebglAddon']> | null = null;
      if (webglModule?.WebglAddon && typeof window !== 'undefined' && typeof WebGL2RenderingContext !== 'undefined') {
        try {
          const addon = new webglModule.WebglAddon();
          addon.onContextLoss(() => {
            if (webglAddon === addon) {
              webglAddon = null;
            }
            addon.dispose();
          });
          term.loadAddon(addon);
          webglAddon = addon;
          xtermDisposables.push(addon);
        } catch {
          // Fall back cleanly to xterm's default renderer when WebGL2 is unavailable.
        }
      }
      xtermDisposables.push(registerTerminalUrlLinkProvider(term));
      termRef.current = term;
      fitRef.current = fitAddon;

      let cursorHidden = false;
      let isComposing = false;
      let compositionAnchor: { x: number; y: number } | null = null;
      let lastVisibleCursor: { x: number; y: number } | null = null;
      let lastSyncedCursorKey = '';
      const findInverseCursor = (): { x: number; y: number } | null => {
        const buf = term.buffer.active;
        const baseRow = buf.viewportY;
        const reusableCell = buf.getNullCell();
        for (let row = term.rows - 1; row >= 0; row -= 1) {
          const line = buf.getLine(baseRow + row);
          if (!line) continue;
          let col = 0;
          while (col < term.cols) {
            const cell = line.getCell(col, reusableCell);
            if (!cell || !cell.isInverse()) {
              col += 1;
              continue;
            }
            const runStart = col;
            let runWidth = 0;
            while (col < term.cols) {
              const cur = line.getCell(col, reusableCell);
              if (!cur || !cur.isInverse()) break;
              const w = cur.getWidth();
              runWidth += w > 0 ? w : 1;
              col += Math.max(1, w);
            }
            // Ink-based TUIs (such as Claude Code) hide the hardware cursor
            // and render a single-cell (or 2-cell CJK) inverse block cursor.
            if (runWidth >= 1 && runWidth <= 2) {
              return { x: runStart, y: row };
            }
          }
        }
        return null;
      };
      const resolveImeCursor = (allowInverseScan: boolean): { x: number; y: number } => {
        const buf = term.buffer.active;
        const hwCursor = { x: buf.cursorX, y: buf.cursorY };
        if (!cursorHidden) return hwCursor;
        if (!allowInverseScan) return lastVisibleCursor ?? hwCursor;
        return findInverseCursor() ?? lastVisibleCursor ?? hwCursor;
      };
      const syncScrollState = () => {
        if (disposed) return;
        const buf = term.buffer.active;
        const hasHistory = buf.type === 'normal' && buf.baseY > 0;
        container.toggleAttribute('data-has-scrollback', hasHistory);
        container.toggleAttribute('data-scrolled-up', hasHistory && buf.viewportY < buf.baseY);
      };
      const syncTextarea = (allowInverseScan = false) => {
        if (disposed) return;
        const buf = term.buffer.active;
        const hasHistory = buf.type === 'normal' && buf.baseY > 0;
        const scrolledUp = hasHistory && buf.viewportY < buf.baseY;
        container.toggleAttribute('data-has-scrollback', hasHistory);
        container.toggleAttribute('data-scrolled-up', scrolledUp);
        // Never scan the buffer or touch DOM layout during passive output when
        // the user is scrolled up or when the TUI hides the hardware cursor.
        if (scrolledUp && !isComposing) return;
        if (cursorHidden && !allowInverseScan && !isComposing) return;
        const cursor = resolveImeCursor(allowInverseScan || isComposing);
        if (!isComposing) lastVisibleCursor = cursor;
        const cursorKey = `${cursor.x},${cursor.y},${term.cols},${term.rows},${isComposing ? 1 : 0}`;
        if (!isComposing && !allowInverseScan && cursorKey === lastSyncedCursorKey) return;
        lastSyncedCursorKey = cursorKey;
        syncHelperTextareaGeometry({
          container,
          cursor,
          cols: term.cols,
          rows: term.rows,
          compositionAnchor,
          isComposing,
        });
      };
      syncTextareaRef.current = () => {
        lastSyncedCursorKey = '';
        syncTextarea(true);
      };

      const scheduleTextareaSync = () => {
        if (disposed || imeAnchorRaf !== 0) return;
        imeAnchorRaf = requestAnimationFrame(() => {
          imeAnchorRaf = 0;
          syncTextarea(isComposing);
        });
      };

      const ensureBottomForIme = () => {
        const buf = term.buffer.active;
        if (buf.type === 'normal' && buf.viewportY < buf.baseY) {
          term.scrollToBottom();
        }
      };

      const handleFocusInCapture = () => {
        lastSyncedCursorKey = '';
        syncTextarea(true);
      };
      const handleKeyDownCapture = (event: KeyboardEvent) => {
        if (!isComposing && (event.keyCode === 229 || event.key === 'Process' || event.isComposing)) {
          ensureBottomForIme();
          lastSyncedCursorKey = '';
          syncTextarea(true);
        }
      };
      const handleCompositionStartCapture = () => {
        ensureBottomForIme();
        compositionAnchor = resolveImeCursor(true);
        isComposing = true;
        lastSyncedCursorKey = '';
        syncTextarea(true);
        scheduleTextareaSync();
      };
      const handleCompositionUpdateCapture = () => {
        if (!isComposing) handleCompositionStartCapture();
        scheduleTextareaSync();
      };
      const handleCompositionEndCapture = () => {
        isComposing = false;
        compositionAnchor = null;
        lastSyncedCursorKey = '';
        scheduleTextareaSync();
      };

      container.addEventListener('focusin', handleFocusInCapture, { capture: true });
      container.addEventListener('keydown', handleKeyDownCapture, { capture: true });
      container.addEventListener('compositionstart', handleCompositionStartCapture, { capture: true });
      container.addEventListener('compositionupdate', handleCompositionUpdateCapture, { capture: true });
      container.addEventListener('compositionend', handleCompositionEndCapture, { capture: true });
      imeCleanupFns.push(() => {
        container.removeAttribute('data-ime-composing');
        container.removeEventListener('focusin', handleFocusInCapture, { capture: true });
        container.removeEventListener('keydown', handleKeyDownCapture, { capture: true });
        container.removeEventListener('compositionstart', handleCompositionStartCapture, { capture: true });
        container.removeEventListener('compositionupdate', handleCompositionUpdateCapture, { capture: true });
        container.removeEventListener('compositionend', handleCompositionEndCapture, { capture: true });
      });

      let wheelDeltaRemainder = 0;
      term.attachCustomWheelEventHandler((event) => {
        const buffer = term.buffer.active;
        // Keep wheel control in local history once the user scrolls above the prompt.
        if (
          term.modes.mouseTrackingMode !== 'none'
          && buffer.type === 'normal'
          && buffer.baseY > 0
          && (event.shiftKey || buffer.viewportY < buffer.baseY)
          && event.deltaY !== 0
        ) {
          const rawLines = event.deltaMode === 1
            ? event.deltaY
            : event.deltaMode === 2
              ? event.deltaY * Math.max(1, term.rows - 1)
              : event.deltaY / 32;
          if (Math.sign(wheelDeltaRemainder) !== Math.sign(rawLines)) {
            wheelDeltaRemainder = 0;
          }
          wheelDeltaRemainder += rawLines;
          const wholeLines = Math.trunc(wheelDeltaRemainder);
          if (wholeLines !== 0) {
            wheelDeltaRemainder -= wholeLines;
            const clampedLines = Math.sign(wholeLines) * Math.min(12, Math.abs(wholeLines));
            term.scrollLines(clampedLines);
          }
          event.preventDefault();
          return false;
        }
        wheelDeltaRemainder = 0;
        return true;
      });

      let suppressInternalClear = false;
      let clearRanInWrite = false;
      let pendingConptyClear = false;
      let trimPostHomeLeak = false;

      const clearPendingTimer = () => {
        if (pendingClearTimer !== null) {
          clearTimeout(pendingClearTimer);
          pendingClearTimer = null;
        }
      };

      const resetClearTracking = () => {
        clearPendingTimer();
        pendingConptyClear = false;
        trimPostHomeLeak = false;
      };

      const cancelOutputFlush = () => {
        if (outputFlushId === null) return;
        if (outputFlushKind === 'raf' && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(outputFlushId as number);
        } else if (outputFlushKind === 'timer') {
          clearTimeout(outputFlushId as ReturnType<typeof setTimeout>);
        }
        outputFlushId = null;
        outputFlushKind = null;
      };

      xtermDisposables.push(
        term.buffer.onBufferChange(scheduleTextareaSync),
        term.onCursorMove(scheduleTextareaSync),
        term.onScroll(syncScrollState),
        term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
          for (const param of params) {
            if (param === 25) {
              cursorHidden = false;
            }
          }
          return false;
        }),
        term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
          for (const param of params) {
            if (param === 25) {
              cursorHidden = true;
            }
          }
          return false;
        }),
        term.parser.registerCsiHandler({ final: 'J' }, (params) => {
          if (!suppressInternalClear && (params[0] ?? 0) === 3) {
            clearRanInWrite = true;
            pendingConptyClear = true;
            trimPostHomeLeak = false;
            clearPendingTimer();
            pendingClearTimer = setTimeout(() => {
              pendingConptyClear = false;
              pendingClearTimer = null;
            }, 150);
          }
          return false;
        }),
        term.parser.registerCsiHandler({ final: 'H' }, (params) => {
          if (pendingConptyClear && term.buffer.active.type === 'normal') {
            const row = typeof params[0] === 'number' ? params[0] : 1;
            const col = typeof params[1] === 'number' ? params[1] : 1;
            if (row <= 1 && col <= 1) {
              pendingConptyClear = false;
              clearPendingTimer();
              clearRanInWrite = true;
              if (term.buffer.active.baseY > 0) {
                trimPostHomeLeak = true;
              }
            }
          }
          return false;
        }),
      );

      const writeChunk = (raw: string, after?: () => void) => {
        const bufferBefore = term.buffer.active;
        const wasAtBottomBeforeWrite = bufferBefore.type !== 'normal' || bufferBefore.viewportY >= bufferBefore.baseY;
        const normalized = normalizeConptyClearChunk(raw);
        term.write(normalized, () => {
          if (disposed) return;
          const shouldTrimLeak = trimPostHomeLeak;
          const shouldSyncClear = clearRanInWrite;
          trimPostHomeLeak = false;
          clearRanInWrite = false;
          const currentBuffer = term.buffer.active;
          const allowAutoScrollOnClear = wasAtBottomBeforeWrite || currentBuffer.baseY === 0;
          let onlyBlankLeaked = false;
          if (shouldTrimLeak && currentBuffer.type === 'normal' && currentBuffer.baseY > 0 && currentBuffer.baseY <= 2) {
            onlyBlankLeaked = true;
            for (let rowIdx = 0; rowIdx < currentBuffer.baseY; rowIdx += 1) {
              const line = currentBuffer.getLine(rowIdx);
              if (line && line.translateToString(true).length > 0) {
                onlyBlankLeaked = false;
                break;
              }
            }
          }
          if (
            onlyBlankLeaked
            && !suppressInternalClear
            && allowAutoScrollOnClear
          ) {
            suppressInternalClear = true;
            term.write('\x1b[3J', () => {
              suppressInternalClear = false;
              if (!disposed) {
                if (wasAtBottomBeforeWrite || term.buffer.active.baseY === 0) {
                  term.scrollToBottom();
                }
                after?.();
              }
            });
            return;
          }
          if (shouldSyncClear && allowAutoScrollOnClear) {
            // xterm's ED 3 resets ydisp/ybase without clearing isUserScrolling;
            // restore bottom follow only when we were already following or scrollback was wiped.
            term.scrollToBottom();
          }
          after?.();
        });
      };

      let pendingAckChars = 0;
      const reportProcessedChars = (count: number) => {
        if (disposed || count <= 0) return;
        pendingAckChars += count;
        if (pendingAckChars >= TERMINAL_ACK_BATCH_CHARS) {
          const toAck = pendingAckChars;
          pendingAckChars = 0;
          connection?.send({ type: 'ack', chars: toAck });
        }
      };

      const flushPendingOutput = (allowRepaintWait = false) => {
        outputFlushId = null;
        outputFlushKind = null;
        if (disposed || !pendingOutputBuffer) return;
        if (allowRepaintWait && waitsForTerminalRepaint(pendingOutputBuffer)) {
          outputFlushKind = 'timer';
          outputFlushId = setTimeout(flushPendingOutput, 12);
          return;
        }
        const { chunk, rest } = sliceTerminalWriteBatch(pendingOutputBuffer);
        pendingOutputBuffer = rest;
        const chunkLength = chunk.length;
        writeChunk(chunk, () => {
          reportProcessedChars(chunkLength);
          scheduleTextareaSync();
        });
        if (rest) {
          scheduleOutputFlush();
        }
      };

      const scheduleOutputFlush = () => {
        if (disposed || replayingSnapshot || outputFlushId !== null || !pendingOutputBuffer) return;
        const canUseRaf = activeRef.current && (typeof document === 'undefined' || !document.hidden);
        if (canUseRaf && typeof requestAnimationFrame === 'function') {
          outputFlushKind = 'raf';
          outputFlushId = requestAnimationFrame(() => flushPendingOutput(true));
        } else {
          outputFlushKind = 'timer';
          outputFlushId = setTimeout(flushPendingOutput, 16);
        }
      };

      const enqueueOutputChunk = (chunk: string) => {
        if (!chunk || disposed) return;
        pendingOutputBuffer += chunk;
        scheduleOutputFlush();
      };

      const safeFit = () => {
        if (
          disposed
          || !activeRef.current
          || !container.isConnected
          || container.clientWidth === 0
          || container.clientHeight === 0
        ) {
          return;
        }
        try {
          const proposed = fitAddon.proposeDimensions();
          if (!proposed || proposed.cols <= 0 || proposed.rows <= 0) return;
          if (proposed.cols === term.cols && proposed.rows === term.rows) {
            syncTextarea();
            return;
          }
          const buffer = term.buffer.active;
          const isNormal = buffer.type === 'normal';
          const wasAtBottom = !isNormal || buffer.viewportY >= buffer.baseY;
          const distanceFromBottom = isNormal ? Math.max(0, buffer.baseY - buffer.viewportY) : 0;
          fitAddon.fit();
          if (restoreScrollFrame !== undefined) cancelAnimationFrame(restoreScrollFrame);
          // xterm updates its viewport's scroll range on the render after a resize.
          restoreScrollFrame = requestAnimationFrame(() => {
            restoreScrollFrame = undefined;
            if (disposed || !activeRef.current || term.buffer.active.type !== 'normal') return;
            if (wasAtBottom) {
              term.scrollToBottom();
            } else {
              const targetY = Math.max(0, term.buffer.active.baseY - distanceFromBottom);
              if (targetY !== term.buffer.active.viewportY) {
                term.scrollToLine(targetY);
              }
            }
            syncTextarea();
          });
          syncTextarea();
        } catch {
          // Ignore layout measurements while unmounting.
        }
      };
      fitFnRef.current = safeFit;

      const scheduleFit = () => {
        clearTimeout(fitTimer);
        if (disposed || !activeRef.current) return;
        // Coalesce sidebar animation and drag events before resizing the PTY.
        fitTimer = setTimeout(safeFit, TERMINAL_RESIZE_SETTLE_MS);
      };

      requestAnimationFrame(() => {
        safeFit();
        syncTextarea();
        if (activeRef.current) term.focus();
      });
      void document.fonts?.ready.then(() => {
        if (disposed) return;
        // Re-trigger character size & glyph width cache calculation once
        // custom fonts finish loading so CJK/monospace cells never drift or overlap.
        term.options.fontFamily = `${TERMINAL_FONT_FAMILY}, sans-serif`;
        term.options.fontFamily = TERMINAL_FONT_FAMILY;
        webglAddon?.clearTextureAtlas();
        if (activeRef.current) {
          safeFit();
          term.refresh(0, Math.max(0, term.rows - 1));
          syncTextarea();
        }
      });

      observer = new ResizeObserver(() => scheduleFit());
      observer.observe(container);

      const appRoot = document.querySelector('.matrius-app');
      if (appRoot) {
        themeObserver = new MutationObserver(() => {
          term.options.theme = buildTerminalTheme();
          webglAddon?.clearTextureAtlas();
        });
        themeObserver.observe(appRoot, {
          attributes: true,
          attributeFilter: ['data-color-mode', 'data-theme'],
        });
      }

      let sendInterrupt = () => {
        scheduleCliRefreshOnSubmit('\x03');
        term.input('\x03', true);
      };
      clipboardCleanup = attachTerminalClipboard({
        terminal: term,
        container,
        sendInterrupt: () => sendInterrupt(),
        onOpenContextMenu: (event) => {
          const clamped = clampTerminalContextMenuPosition(
            event.clientX,
            event.clientY,
            window.innerWidth,
            window.innerHeight,
          );
          setContextMenu({
            left: clamped.left,
            top: clamped.top,
            hasSelection: term.hasSelection() && Boolean(term.getSelection()),
          });
          syncTextarea();
        },
        isDisposed: () => disposed,
      });

      if (preview) {
        const promptDir = previewCwdRef.current || '~';
        const commandBanner = previewCommandRef.current;
        const banner = commandBanner
          ? `\x1b[36m${promptDir}\x1b[0m \x1b[90m›\x1b[0m ${commandBanner}\r\n`
          : `\x1b[36m${promptDir}\x1b[0m \x1b[90m$\x1b[0m `;
        term.write(banner);
        term.onData((data) => {
          scheduleCliRefreshOnSubmit(data);
          if (data === '\r') {
            const cmd = previewLine.trim();
            previewLine = '';
            term.write(`\r\n${cmd ? `\x1b[90m[预览模式] ${cmd}\x1b[0m\r\n` : ''}\x1b[36m${promptDir}\x1b[0m \x1b[90m$\x1b[0m `);
            return;
          }
          if (data === '\x7f') {
            if (previewLine.length > 0) {
              previewLine = previewLine.slice(0, -1);
              term.write('\b \b');
            }
            return;
          }
          if (data >= ' ') {
            previewLine += data;
            term.write(data);
          }
        });
        return;
      }

      lastSentSizeRef.current = { cols: 0, rows: 0 };
      setConnectionStatus('connecting');

      const sendInput = (data: string) => {
        if (connection?.send({ type: 'input', data })) scheduleCliRefreshOnSubmit(data);
      };

      const sendResizeIfChanged = () => {
        if (term.cols <= 0 || term.rows <= 0) return;
        const prev = lastSentSizeRef.current;
        if (prev.cols === term.cols && prev.rows === term.rows) return;
        if (connection?.send({ type: 'resize', cols: term.cols, rows: term.rows })) {
          lastSentSizeRef.current = { cols: term.cols, rows: term.rows };
        }
      };

      sendInterrupt = () => sendInput('\x03');

      connection = connectWorkTerminal(workTerminalWsUrl(session.id), (status) => {
        setConnectionStatus(status);
        if (status === 'connected') {
          lastSentSizeRef.current = { cols: 0, rows: 0 };
          safeFit();
          sendResizeIfChanged();
        }
      }, (message) => {
        if (message.type === 'snapshot') {
          const version = ++snapshotVersion;
          cancelOutputFlush();
          pendingOutputBuffer = '';
          pendingAckChars = 0;
          replayingSnapshot = true;
          // Drain xterm writes queued by the previous connection before resetting its buffer.
          term.write('', () => {
            if (disposed || version !== snapshotVersion) return;
            resetClearTracking();
            term.reset();
            writeChunk(message.data, () => {
              if (version !== snapshotVersion) return;
              term.scrollToBottom();
              syncTextarea();
              replayingSnapshot = false;
              scheduleOutputFlush();
            });
          });
        } else if (message.type === 'output') {
          enqueueOutputChunk(message.data);
        } else if (message.type === 'status') {
          updateWorkTerminalStatus(session.id, message.status, message.exitCode, message.message);
          if (presetRef.current !== 'shell' && message.status === 'exited') {
            bumpCliSessionsRefresh();
          }
        }
      });
      retryConnectionRef.current = connection.retry;

      term.onData(sendInput);

      term.onResize(() => {
        sendResizeIfChanged();
      });
    })();

    return () => {
      disposed = true;
      fitFnRef.current = null;
      syncTextareaRef.current = null;
      clearTimeout(fitTimer);
      if (restoreScrollFrame !== undefined) cancelAnimationFrame(restoreScrollFrame);
      if (imeAnchorRaf !== 0 && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(imeAnchorRaf);
      }
      if (outputFlushId !== null) {
        if (outputFlushKind === 'raf' && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(outputFlushId as number);
        } else if (outputFlushKind === 'timer') {
          clearTimeout(outputFlushId as ReturnType<typeof setTimeout>);
        }
      }
      if (pendingClearTimer !== null) {
        clearTimeout(pendingClearTimer);
      }
      if (cliRefreshShortTimer !== null) {
        clearTimeout(cliRefreshShortTimer);
      }
      if (cliRefreshFollowupTimer !== null) {
        clearTimeout(cliRefreshFollowupTimer);
      }
      for (const cleanup of imeCleanupFns) {
        cleanup();
      }
      for (const disposable of xtermDisposables) {
        disposable.dispose();
      }
      clipboardCleanup?.();
      clipboardCleanup = null;
      observer?.disconnect();
      themeObserver?.disconnect();
      connection?.dispose();
      retryConnectionRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [preview, session.id]);

  const performResume = useCallback(async (options?: { password?: string; rememberPassword?: boolean }) => {
    if (restarting) return;
    setRestarting(true);
    try {
      if (preview) {
        updateWorkTerminalStatus(session.id, 'running', null);
        return;
      }
      const term = termRef.current;
      const password = options?.password?.trim();
      const resumed = await resumeWorkTerminal(instance.request, session.id, {
        ...(term && term.cols > 0 ? { cols: term.cols, rows: term.rows } : {}),
        ...(password ? { password, rememberPassword: Boolean(options?.rememberPassword) } : {}),
      });
      if (password) {
        setSshPassword('');
        bumpHostUnlockVersion();
      }
      replaceWorkTerminalSession(resumed);
      termRef.current?.focus();
    } catch (reason) {
      const message = reason instanceof Error && reason.message ? reason.message : '恢复终端连接失败。';
      updateWorkTerminalStatus(session.id, 'error', null, message);
    } finally {
      setRestarting(false);
    }
  }, [instance.request, preview, restarting, session.id]);

  useEffect(() => {
    if (preview || !active) return;
    if (session.status === 'restored' && autoResumedRef.current !== session.id) {
      autoResumedRef.current = session.id;
      const timer = setTimeout(() => {
        void performResume();
      }, 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [active, performResume, preview, session.id, session.status]);

  useEffect(() => {
    if (lastUnlockRef.current === hostUnlockVersion) return;
    lastUnlockRef.current = hostUnlockVersion;
    if (preview || !active || !isSshSession || session.status === 'running') return;
    const timer = setTimeout(() => {
      void performResume();
    }, 0);
    return () => clearTimeout(timer);
  }, [active, hostUnlockVersion, isSshSession, performResume, preview, session.status]);

  const visibleContextMenu = active ? contextMenu : null;

  useEffect(() => {
    if (!active || !canMountXterm()) return undefined;
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          fitFnRef.current?.();
          const term = termRef.current;
          if (term && term.rows > 0) {
            term.refresh(0, term.rows - 1);
          }
          syncTextareaRef.current?.();
        } catch {
          // Ignore fit measurements during transition.
        }
      }
      termRef.current?.focus();
    });
    return () => {
      if (typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
      }
    };
  }, [active]);

  useEffect(() => {
    if (!visibleContextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        termRef.current?.focus();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        );
        if (buttons.length === 0) return;
        event.preventDefault();
        const activeIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = activeIndex === -1
          ? (delta > 0 ? 0 : buttons.length - 1)
          : (activeIndex + delta + buttons.length) % buttons.length;
        buttons[nextIndex]?.focus();
        return;
      }
      if (event.key === 'Tab') {
        closeMenu();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('blur', closeMenu);
    };
  }, [visibleContextMenu]);

  useEffect(() => {
    if (!visibleContextMenu) return;
    requestAnimationFrame(() => {
      const firstButton = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
      firstButton?.focus();
    });
  }, [visibleContextMenu]);

  function handleContextCopy() {
    const term = termRef.current;
    setContextMenu(null);
    if (!term || !term.hasSelection()) {
      term?.focus();
      return;
    }
    const selected = term.getSelection();
    if (selected) {
      void Promise.resolve(copyText(selected)).catch(() => {
        showClipboardHint('复制失败，请检查剪贴板权限');
      });
    }
    term.clearSelection();
    term.focus();
  }

  function handleContextPaste() {
    const term = termRef.current;
    setContextMenu(null);
    if (!term) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      term.focus();
      showClipboardHint('当前浏览器不支持读取剪贴板，请使用 Ctrl+V 粘贴');
      return;
    }
    void navigator.clipboard.readText()
      .then((text) => {
        if (text) {
          term.paste(text);
        }
        term.focus();
      })
      .catch(() => {
        term.focus();
        showClipboardHint('请允许剪贴板访问，或直接使用 Ctrl+V 粘贴');
      });
  }

  function handleClose() {
    removeWorkTerminal(session.id);
    if (!preview) {
      void deleteWorkTerminal(instance.request, session.id).catch(() => {});
    }
  }

  return (
    <div
      className={`work-terminal-pane${active ? '' : ' is-hidden'}`}
      data-terminal-id={session.id}
      data-project-id={session.projectId}
      aria-hidden={!active}
    >
      <div
        className="work-terminal-frame"
        onKeyDownCapture={(event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest('.work-terminal-status-bar, .work-terminal-menu')) return;
          if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
            const key = event.key.toLowerCase();
            if (key === 'o' || event.code === 'KeyO') {
              event.preventDefault();
              if (!target?.classList.contains('xterm-helper-textarea')) {
                termRef.current?.focus();
              }
            }
          }
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement | null)?.closest('.work-terminal-status-bar, .work-terminal-menu')) return;
          setContextMenu(null);
          termRef.current?.focus();
        }}
        onMouseUp={(event) => {
          if ((event.target as HTMLElement | null)?.closest('.scrollbar')) {
            requestAnimationFrame(() => termRef.current?.focus());
          }
        }}
      >
        <div className="work-terminal-surface">
          <div ref={containerRef} className="work-terminal-canvas" />
          <button
            type="button"
            className="icon-button work-terminal-scroll-bottom"
            aria-label="回到终端底部"
            onClick={() => {
              termRef.current?.scrollToBottom();
              termRef.current?.focus();
            }}
          >
            <ArrowDown size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
        {visibleContextMenu && (
          <div
            ref={menuRef}
            className="conversation-menu work-terminal-menu"
            role="menu"
            aria-label="终端右键菜单"
            style={{ left: visibleContextMenu.left, top: visibleContextMenu.top }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={!visibleContextMenu.hasSelection}
              onClick={handleContextCopy}
            >
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="work-terminal-menu-label">复制</span>
              <span className="work-terminal-menu-shortcut">Ctrl+C</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleContextPaste}
            >
              <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className="work-terminal-menu-label">粘贴</span>
              <span className="work-terminal-menu-shortcut">Ctrl+V</span>
            </button>
          </div>
        )}
        {clipboardHint && session.status === 'running' && (
          <div className="work-terminal-context-hint" role="status">
            {clipboardHint}
          </div>
        )}
        {!preview && connectionStatus !== 'connected' && (
          <div className="work-terminal-status-bar">
            <span role="status">
              {connectionStatus === 'connecting' && '正在连接终端…'}
              {connectionStatus === 'reconnecting' && '终端连接已断开，正在重连…'}
              {connectionStatus === 'disconnected' && '终端连接已断开'}
              {connectionStatus === 'missing' && '终端会话已不存在'}
            </span>
            {connectionStatus === 'disconnected' && (
              <button
                type="button"
                className="secondary-button work-terminal-action-btn"
                onClick={() => retryConnectionRef.current?.()}
              >
                重试连接
              </button>
            )}
            {connectionStatus === 'missing' && (
              <button
                type="button"
                className="secondary-button work-terminal-action-btn"
                onClick={handleClose}
              >
                关闭标签
              </button>
            )}
          </div>
        )}
        {session.status !== 'running' && connectionStatus !== 'missing' && (
          <div className="work-terminal-status-bar" role="status">
            <span>
              {session.errorMessage ?? (
                session.status === 'restored'
                  ? `已保存上次状态（${session.cwd}），正在恢复连接…`
                  : `进程已结束${session.exitCode !== null ? `（退出码 ${session.exitCode}）` : ''}`
              )}
            </span>
            <div className="work-terminal-status-actions">
              {isSshSession && !preview && (
                <div className="work-terminal-unlock-form">
                  <input
                    type="password"
                    className="text-field work-terminal-password-input"
                    value={sshPassword}
                    onChange={(event) => setSshPassword(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    placeholder="SSH 密码（如需）"
                    autoComplete="current-password"
                    disabled={restarting}
                  />
                  <label
                    className="work-unlock-remember"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={rememberPassword}
                      onChange={(event) => setRememberPassword(event.target.checked)}
                      disabled={restarting}
                    />
                    <span>记住</span>
                  </label>
                </div>
              )}
              <button
                type="button"
                className="secondary-button work-terminal-action-btn"
                disabled={restarting}
                onClick={(event) => {
                  event.stopPropagation();
                  void performResume({ password: sshPassword, rememberPassword });
                }}
              >
                <RotateCw size={13} strokeWidth={1.75} aria-hidden="true" />
                {session.status === 'restored' || isSshSession ? '重新连接' : '重新启动'}
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label={`关闭终端：${session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleClose();
                }}
              >
                <X size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkTerminalView({
  terminals,
  activeProjectId,
  activeTerminalId,
  hidden = false,
}: {
  terminals: readonly WorkTerminalSession[];
  activeProjectId: string | null;
  activeTerminalId: string | null;
  hidden?: boolean;
}) {
  // Keep xterm pane DOM order stable by creation order so pinning/reordering tabs
  // never moves live terminal containers in the DOM and blurs active focus.
  const stablePanes = [...terminals].sort(
    (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  );
  return (
    <div className="work-terminal-stack" hidden={hidden} aria-hidden={hidden || undefined}>
      {stablePanes.map((session) => (
        <WorkTerminalPane
          key={session.id}
          session={session}
          active={!hidden && session.projectId === activeProjectId && session.id === activeTerminalId}
        />
      ))}
    </div>
  );
}
