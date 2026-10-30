import { useSyncExternalStore } from 'react';

/** The address bar is the source of truth for which page is open. The router's own state can
    be momentarily reset while the workspace is rebuilt (for example when the auth check runs
    on returning to a tab), and reading `location` only during render misses later history
    updates. Patch history once so every navigation, including Expo Router's, notifies React. */

const LOCATION_EVENT = 'matrius:location-change';
let patched = false;

function patchHistory() {
  if (patched || typeof window === 'undefined' || !globalThis.history) return;
  patched = true;
  const history = globalThis.history;
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    history[method] = function (this: History, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event(LOCATION_EVENT));
      return result;
    } as typeof original;
  }
}
patchHistory();

function subscribe(onChange: () => void) {
  window.addEventListener(LOCATION_EVENT, onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener(LOCATION_EVENT, onChange);
    window.removeEventListener('popstate', onChange);
  };
}

export function useLocationPathname(): string {
  return useSyncExternalStore(subscribe, () => globalThis.location?.pathname ?? '/', () => '/');
}
