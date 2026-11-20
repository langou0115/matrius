import { useSyncExternalStore } from 'react';

const ACTIVE_PROJECT_KEY = 'matrius:active-work-project';
let memoryActiveProjectId: string | null = null;
const listeners = new Set<() => void>();

function readSessionProjectId(): string | null {
  try {
    const value = globalThis.sessionStorage?.getItem(ACTIVE_PROJECT_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

export function readActiveProjectId(): string | null {
  return memoryActiveProjectId ?? readSessionProjectId();
}

export function writeActiveProjectId(projectId: string | null): void {
  const current = readActiveProjectId();
  memoryActiveProjectId = projectId;
  try {
    if (projectId) globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, projectId);
    else globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    // Ignore storage restrictions.
  }
  if (current !== projectId) {
    listeners.forEach((listener) => listener());
  }
}

function subscribeActiveProject(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useActiveProjectId(): string | null {
  return useSyncExternalStore<string | null>(
    subscribeActiveProject,
    readActiveProjectId,
    () => null,
  );
}

export function resetWorkStateForTests(): void {
  memoryActiveProjectId = null;
  try {
    globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    // Ignore storage failures in tests.
  }
  listeners.forEach((listener) => listener());
}
