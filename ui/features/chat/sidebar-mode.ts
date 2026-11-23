import { createContext, useContext, useSyncExternalStore } from 'react';

export type SidebarTab = 'work' | 'chat';

/**
 * Provided by AppShell when mounted inside the full router so explicit routes (`/work`,
 * `/p/:id`, `/c/:id`, `/`) drive the sidebar mode synchronously without a first-paint flash.
 * Stays `undefined` in isolated component tests that stub `@/router`.
 */
export const SidebarRouteTabContext = createContext<SidebarTab | null | undefined>(undefined);

export function useSidebarRouteTab(): SidebarTab | null | undefined {
  return useContext(SidebarRouteTabContext);
}

const STORAGE_KEY = 'matrius:sidebar-tab';
let memoryTab: SidebarTab | null = null;
const listeners = new Set<() => void>();

function readSessionTab(): SidebarTab | null {
  try {
    const value = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    return value === 'work' || value === 'chat' ? value : null;
  } catch {
    return null;
  }
}

/** Remember the active desktop sidebar tab across full-page Settings navigation. */
export function readSidebarTab(desktop: boolean): SidebarTab {
  if (!desktop) return 'chat';
  return memoryTab ?? readSessionTab() ?? 'chat';
}

export function writeSidebarTab(tab: SidebarTab): void {
  const current = memoryTab ?? readSessionTab() ?? 'chat';
  memoryTab = tab;
  try {
    globalThis.sessionStorage?.setItem(STORAGE_KEY, tab);
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  if (current !== tab) {
    listeners.forEach((listener) => listener());
  }
}

export function subscribeSidebarTab(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSidebarTab(desktop: boolean): SidebarTab {
  const current = useSyncExternalStore<SidebarTab>(
    subscribeSidebarTab,
    () => readSidebarTab(true),
    () => 'chat',
  );
  return desktop ? current : 'chat';
}

export function resetSidebarTabForTests(): void {
  memoryTab = null;
  try {
    globalThis.sessionStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures in tests.
  }
  listeners.forEach((listener) => listener());
}
