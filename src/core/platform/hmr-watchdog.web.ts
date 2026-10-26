import { hasActiveBrowserRun } from './run-protection.web';

/** The slice of WebSocket this watchdog uses; tests supply their own implementation. */
export type HmrSocket = {
  close(): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

type WatchOptions = {
  url: string;
  createSocket: (url: string) => HmrSocket;
  reload: () => void;
  retryDelayMs?: number;
  /** Hold the reload while a local run is still writing, like the HMR pause itself. */
  canReload?: () => boolean;
  wait?: (ms: number) => Promise<void>;
};

/**
 * Metro's web HMR client never reconnects. When the dev server restarts, the
 * laptop suspends or the WSL relay drops the socket, the open tab keeps running
 * but silently stops applying edits until it is reloaded by hand. Watch the same
 * endpoint and reload once the server is reachable again.
 */
export function watchDevelopmentServer({
  url, createSocket, reload, retryDelayMs = 1000, canReload = () => true,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: WatchOptions) {
  let stopped = false;
  let recovering = false;

  const monitor = createSocket(url);
  monitor.onclose = () => { void recover(); };

  /** One short-lived connection decides whether the server is accepting clients. */
  async function probe(): Promise<boolean> {
    const socket = createSocket(url);
    const opened = await new Promise<boolean>((resolve) => {
      socket.onopen = () => resolve(true);
      socket.onclose = () => resolve(false);
    });
    socket.close();
    return opened;
  }

  async function recover() {
    if (stopped || recovering) return;
    recovering = true;
    try {
      while (!stopped) {
        if (await probe()) {
          while (!stopped && !canReload()) await wait(retryDelayMs);
          if (stopped) return;
          stopped = true;
          reload();
          return;
        }
        await wait(retryDelayMs);
      }
    } finally {
      recovering = false;
    }
  }

  return {
    stop() {
      stopped = true;
      monitor.onclose = null;
      monitor.close();
    },
  };
}

const RELOAD_KEY = 'matrius:dev-hmr-reload';
/** A flapping relay must not turn the tab into a reload loop. */
const RELOAD_MIN_INTERVAL_MS = 15_000;

function reloadAfterRecovery() {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_MIN_INTERVAL_MS) {
      console.warn('开发服务器连接刚恢复过，暂不重复刷新。如页面仍未更新，请手动刷新。');
      return;
    }
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable in private or sandboxed contexts; a reload is
    // still better than an indefinitely stale tab.
  }
  window.location.reload();
}

function reloadWhenIdle() {
  if (hasActiveBrowserRun()) {
    setTimeout(reloadWhenIdle, 1000);
    return;
  }
  reloadAfterRecovery();
}

type DevWindow = Window & { __matriusDevHmrWatchdog?: boolean };

export function startDevelopmentHmrRecovery() {
  if (typeof window === 'undefined') return;
  const target = window as DevWindow;
  if (target.__matriusDevHmrWatchdog) return;
  target.__matriusDevHmrWatchdog = true;

  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const watchdog = watchDevelopmentServer({
    url: `${scheme}://${window.location.host}/hot`,
    createSocket: (url) => new WebSocket(url),
    canReload: () => !hasActiveBrowserRun(),
    reload: reloadAfterRecovery,
  });

  // A page frozen into the back/forward cache keeps the HMR client it had, and
  // that client's socket died while frozen. Only a fresh load revives it.
  window.addEventListener('pagehide', () => watchdog.stop(), { once: true });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) reloadWhenIdle();
  });
}
