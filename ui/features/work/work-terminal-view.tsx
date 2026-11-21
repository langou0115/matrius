import { LOCAL_WORK_HOST_ID } from '@contract/work-projects';
import {
  normalizeConptyClearChunk,
  type WorkTerminalServerMessage,
  type WorkTerminalSession,
} from '@contract/work-terminals';
import { RotateCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { copyText } from '@/core/platform/clipboard';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { deleteWorkTerminal, resumeWorkTerminal, workTerminalWsUrl } from './work-api';
import {
  bumpHostUnlockVersion,
  detectPreviewPlatform,
  removeWorkTerminal,
  replaceWorkTerminalSession,
  updateWorkTerminalStatus,
  useWorkState,
} from './work-state';

type XtermInstance = import('@xterm/xterm').Terminal;
type XtermTheme = import('@xterm/xterm').ITheme;
type XtermWindowsPty = import('@xterm/xterm').IWindowsPty;
type FitAddonInstance = import('@xterm/addon-fit').FitAddon;

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

export type TerminalClipboardTarget = {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  focus(): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
};

/** Bind right-click copy on active selection plus Ctrl+C copy and native Ctrl+V paste. */
export function attachTerminalClipboard(options: {
  terminal: TerminalClipboardTarget;
  container: HTMLElement;
  sendInterrupt: () => void;
  copyTextFn?: (text: string) => Promise<void>;
  isDisposed?: () => boolean;
}): () => void {
  const {
    terminal,
    container,
    sendInterrupt,
    copyTextFn = copyText,
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
    if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isPasteKey) {
      return false;
    }

    return true;
  });

  const handleContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented || !copySelection()) return;
    event.preventDefault();
    event.stopPropagation();
  };

  container.addEventListener('contextmenu', handleContextMenu, { capture: true });
  return () => {
    container.removeEventListener('contextmenu', handleContextMenu, { capture: true });
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
  const wsRef = useRef<WebSocket | null>(null);
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

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    windowsPtyRef.current = windowsPty;
    if (termRef.current) {
      termRef.current.options.windowsPty = windowsPty ?? {};
    }
  }, [windowsPty]);

  const initialCwd = session.cwd;
  const initialCommand = session.command;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !canMountXterm()) return;

    let disposed = false;
    let fitRaf = 0;
    let observer: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let pendingClearTimer: ReturnType<typeof setTimeout> | null = null;
    let clipboardCleanup: (() => void) | null = null;
    const parserDisposables: Array<{ dispose(): void }> = [];
    let previewLine = '';

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed) return;

      const fitAddon = new FitAddon();
      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        cursorWidth: 1,
        cursorInactiveStyle: 'none',
        fontFamily: "JetBrainsMono, 'Cascadia Mono', Consolas, NotoSansSC, ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 14,
        lineHeight: 1.15,
        letterSpacing: 0,
        scrollback: 5000,
        smoothScrollDuration: 100,
        allowTransparency: false,
        theme: buildTerminalTheme(),
        ...(windowsPtyRef.current ? { windowsPty: windowsPtyRef.current } : {}),
      });
      term.loadAddon(fitAddon);
      term.open(container);
      termRef.current = term;
      fitRef.current = fitAddon;

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

      parserDisposables.push(
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
        const normalized = normalizeConptyClearChunk(raw);
        term.write(normalized, () => {
          if (disposed) return;
          const shouldTrimLeak = trimPostHomeLeak;
          const shouldSyncClear = clearRanInWrite;
          trimPostHomeLeak = false;
          clearRanInWrite = false;
          if (shouldTrimLeak && !suppressInternalClear && term.buffer.active.type === 'normal' && term.buffer.active.baseY > 0) {
            suppressInternalClear = true;
            term.write('\x1b[3J', () => {
              suppressInternalClear = false;
              if (!disposed) {
                term.scrollToBottom();
                after?.();
              }
            });
            return;
          }
          if (shouldSyncClear) {
            // xterm's ED 3 resets ydisp/ybase without clearing isUserScrolling;
            // explicitly snap to bottom so new output keeps following smoothly.
            term.scrollToBottom();
          }
          after?.();
        });
      };

      const safeFit = () => {
        if (disposed || !container.isConnected || container.clientWidth === 0 || container.clientHeight === 0) return;
        try {
          const buffer = term.buffer.active;
          const wasAtBottom = buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY;
          fitAddon.fit();
          if (wasAtBottom && term.buffer.active.type === 'normal') {
            term.scrollToBottom();
          }
        } catch {
          // Ignore layout measurements while unmounting.
        }
      };

      const scheduleFit = () => {
        if (disposed || fitRaf !== 0) return;
        fitRaf = requestAnimationFrame(() => {
          fitRaf = 0;
          safeFit();
        });
      };

      requestAnimationFrame(() => {
        safeFit();
        if (activeRef.current) term.focus();
      });
      void document.fonts?.ready.then(() => scheduleFit());

      observer = new ResizeObserver(() => scheduleFit());
      observer.observe(container);

      const appRoot = document.querySelector('.matrius-app');
      if (appRoot) {
        themeObserver = new MutationObserver(() => {
          term.options.theme = buildTerminalTheme();
        });
        themeObserver.observe(appRoot, {
          attributes: true,
          attributeFilter: ['data-color-mode', 'data-theme'],
        });
      }

      let sendInterrupt = () => {
        term.input('\x03', true);
      };
      clipboardCleanup = attachTerminalClipboard({
        terminal: term,
        container,
        sendInterrupt: () => sendInterrupt(),
        isDisposed: () => disposed,
      });

      if (preview) {
        const promptDir = initialCwd || '~';
        const banner = initialCommand
          ? `\x1b[36m${promptDir}\x1b[0m \x1b[90m›\x1b[0m ${initialCommand}\r\n`
          : `\x1b[36m${promptDir}\x1b[0m \x1b[90m$\x1b[0m `;
        term.write(banner);
        term.onData((data) => {
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

      const ws = new WebSocket(workTerminalWsUrl(session.id));
      wsRef.current = ws;

      const sendInput = (data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      };

      const sendResize = () => {
        if (ws.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      };

      sendInterrupt = () => {
        sendInput('\x03');
      };

      ws.addEventListener('open', () => {
        safeFit();
        sendResize();
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WorkTerminalServerMessage;
          if (msg.type === 'snapshot') {
            resetClearTracking();
            term.reset();
            if (msg.data) {
              writeChunk(msg.data, () => term.scrollToBottom());
            }
          } else if (msg.type === 'output') {
            writeChunk(msg.data);
          } else if (msg.type === 'status') {
            updateWorkTerminalStatus(session.id, msg.status, msg.exitCode, msg.message);
          }
        } catch {
          // Ignore invalid terminal control payloads.
        }
      });

      ws.addEventListener('close', () => {
        if (!disposed) {
          wsRef.current = null;
        }
      });

      term.onData((data) => {
        sendInput(data);
      });

      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        }
      });
    })();

    return () => {
      disposed = true;
      if (fitRaf !== 0 && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(fitRaf);
      }
      if (pendingClearTimer !== null) {
        clearTimeout(pendingClearTimer);
      }
      for (const disposable of parserDisposables) {
        disposable.dispose();
      }
      clipboardCleanup?.();
      clipboardCleanup = null;
      observer?.disconnect();
      themeObserver?.disconnect();
      wsRef.current?.close();
      wsRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [initialCommand, initialCwd, preview, session.id]);

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

  useEffect(() => {
    if (!active || !canMountXterm()) return;
    const raf = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (container && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          const term = termRef.current;
          const buffer = term?.buffer.active;
          const wasAtBottom = !buffer || buffer.type !== 'normal' || buffer.viewportY >= buffer.baseY;
          fitRef.current?.fit();
          if (term && wasAtBottom && term.buffer.active.type === 'normal') {
            term.scrollToBottom();
          }
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN && term) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
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
        onClick={(event) => {
          if ((event.target as HTMLElement | null)?.closest('.work-terminal-status-bar')) return;
          termRef.current?.focus();
        }}
        onMouseUp={(event) => {
          if ((event.target as HTMLElement | null)?.closest('.scrollbar')) {
            requestAnimationFrame(() => termRef.current?.focus());
          }
        }}
      >
        <div ref={containerRef} className="work-terminal-canvas" />
        {session.status !== 'running' && (
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
