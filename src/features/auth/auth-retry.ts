/** A failed account check is almost always a short backend restart (uvicorn --reload). */
export type AuthStatus = 'checking' | 'anonymous' | 'authenticated' | 'unavailable';

/**
 * Backoff for retrying the account check while the server is unreachable. The last step
 * keeps repeating, so a running development session reconnects on its own instead of
 * leaving the library and account entry missing until the tab is hidden and shown again.
 */
export const AUTH_RETRY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000] as const;

export function retryDelay(attempt: number): number {
  const index = Math.min(Math.max(Math.trunc(attempt) || 0, 0), AUTH_RETRY_DELAYS_MS.length - 1);
  return AUTH_RETRY_DELAYS_MS[index];
}

type Timers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

/**
 * Watches the session status and schedules a retry whenever it settles on `unavailable`.
 * Timers are injected so the policy can be tested without waiting on real time.
 */
export function createAuthRetry({ getStatus, refresh, subscribe, isVisible = () => true,
  setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }: {
  getStatus: () => AuthStatus;
  refresh: () => void | Promise<void>;
  subscribe: (listener: () => void) => () => void;
  isVisible?: () => boolean;
  setTimer?: Timers['set'];
  clearTimer?: Timers['clear'];
}) {
  let attempt = 0;
  let timer: unknown = null;
  let disposed = false;

  const cancel = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const schedule = () => {
    if (disposed) return;
    cancel();
    if (getStatus() !== 'unavailable') return;
    const delay = retryDelay(attempt);
    attempt = Math.min(attempt + 1, AUTH_RETRY_DELAYS_MS.length - 1);
    timer = setTimer(() => {
      timer = null;
      // A hidden tab that retries keeps burning requests; wait for the next check instead.
      if (!isVisible()) { schedule(); return; }
      void refresh();
    }, delay);
  };

  const onStatus = () => {
    const status = getStatus();
    if (status === 'unavailable') { schedule(); return; }
    cancel();
    if (status === 'authenticated' || status === 'anonymous') attempt = 0;
  };

  const unsubscribe = subscribe(onStatus);
  onStatus();

  return {
    dispose() {
      disposed = true;
      cancel();
      unsubscribe();
    },
  };
}
