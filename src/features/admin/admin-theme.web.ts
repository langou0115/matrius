import { useSyncExternalStore } from 'react';

/** The admin console keeps its own palette and never follows the chat appearance settings. */
export type AdminColorMode = 'light' | 'dark';

const STORAGE_KEY = 'matrius-admin-color-mode';
const listeners = new Set<() => void>();
let current: AdminColorMode | null = null;

function readStoredMode(): AdminColorMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage can be unavailable in private or restricted contexts; keep the default.
  }
  return 'light';
}

function getMode(): AdminColorMode {
  current ??= readStoredMode();
  return current;
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

function toggleMode() {
  current = getMode() === 'dark' ? 'light' : 'dark';
  try {
    window.localStorage.setItem(STORAGE_KEY, current);
  } catch {
    // In-memory mode still works for this page.
  }
  for (const listener of listeners) listener();
}

export function useAdminColorMode() {
  const mode = useSyncExternalStore<AdminColorMode>(subscribe, getMode, () => 'light');
  return { mode, toggle: toggleMode };
}
