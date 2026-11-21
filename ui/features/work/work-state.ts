import type { WorkHost } from '@contract/work-hosts';
import type { WorkProject } from '@contract/work-projects';
import {
  DEFAULT_WINDOWS_SHELL,
  normalizeOptionalWindowsShell,
  normalizeWorkTerminalTitle,
  type WindowsTerminalShell,
  type WorkTerminalPatchInput,
  type WorkTerminalSession,
  type WorkTerminalStatus,
} from '@contract/work-terminals';
import { useSyncExternalStore } from 'react';

const ACTIVE_PROJECT_KEY = 'matrius:active-work-project';
const ACTIVE_TERMINALS_KEY = 'matrius:work-active-terminals';
const FILES_PANEL_WIDTH_KEY = 'matrius:work-files-width';
const DEFAULT_WINDOWS_SHELL_KEY = 'matrius:work-default-windows-shell';

export const MIN_WORK_FILES_WIDTH = 220;
export const MAX_WORK_FILES_WIDTH = 640;

export function clampWorkFilesWidth(width: number, maxWidth = MAX_WORK_FILES_WIDTH): number {
  const upper = Math.max(MIN_WORK_FILES_WIDTH, Math.min(MAX_WORK_FILES_WIDTH, maxWidth));
  if (!Number.isFinite(width)) return MIN_WORK_FILES_WIDTH;
  return Math.round(Math.min(upper, Math.max(MIN_WORK_FILES_WIDTH, width)));
}

export function isWindowsPlatform(platform: string | null | undefined): boolean {
  return platform === 'win32';
}

export function detectPreviewPlatform(): 'win32' | 'linux' {
  if (typeof navigator === 'undefined') return 'linux';
  const raw = (
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || navigator.userAgent
    || ''
  ).toLowerCase();
  return raw.includes('win') ? 'win32' : 'linux';
}

export type WorkStoreSnapshot = {
  activeProjectId: string | null;
  projects: WorkProject[];
  projectsLoaded: boolean;
  projectsError: string | null;
  hosts: WorkHost[];
  terminals: WorkTerminalSession[];
  activeTerminalId: string | null;
  activeTerminalByProject: Record<string, string | null>;
  filesPanelOpen: boolean;
  filesPanelWidth: number | null;
  serverPlatform: string | null;
  defaultWindowsShell: WindowsTerminalShell;
  defaultWindowsShellLoaded: boolean;
  hostUnlockVersion: number;
};

function readSessionProjectId(): string | null {
  try {
    const value = globalThis.sessionStorage?.getItem(ACTIVE_PROJECT_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function readStoredActiveTerminals(): Record<string, string | null> {
  try {
    const raw = globalThis.localStorage?.getItem(ACTIVE_TERMINALS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const next: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) next[key] = value;
      else if (value === null) next[key] = null;
    }
    return next;
  } catch {
    return {};
  }
}

function persistActiveTerminals(map: Record<string, string | null>): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_TERMINALS_KEY, JSON.stringify(map));
  } catch {
    // Ignore storage restrictions.
  }
}

function readStoredFilesWidth(): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(FILES_PANEL_WIDTH_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampWorkFilesWidth(parsed) : null;
  } catch {
    return null;
  }
}

function readStoredDefaultWindowsShell(): WindowsTerminalShell {
  try {
    return normalizeOptionalWindowsShell(globalThis.localStorage?.getItem(DEFAULT_WINDOWS_SHELL_KEY))
      ?? DEFAULT_WINDOWS_SHELL;
  } catch {
    return DEFAULT_WINDOWS_SHELL;
  }
}

function resolveProjectActiveTerminal(
  terminals: readonly WorkTerminalSession[],
  projectId: string | null,
  preferredId?: string | null,
): string | null {
  if (!projectId) return null;
  const scoped = terminals.filter((item) => item.projectId === projectId);
  if (scoped.length === 0) return null;
  if (preferredId && scoped.some((item) => item.id === preferredId)) return preferredId;
  return scoped[0].id;
}

function createInitialState(): WorkStoreSnapshot {
  return {
    activeProjectId: readSessionProjectId(),
    projects: [],
    projectsLoaded: false,
    projectsError: null,
    hosts: [],
    terminals: [],
    activeTerminalId: null,
    activeTerminalByProject: readStoredActiveTerminals(),
    filesPanelOpen: true,
    filesPanelWidth: readStoredFilesWidth(),
    serverPlatform: null,
    defaultWindowsShell: readStoredDefaultWindowsShell(),
    defaultWindowsShellLoaded: false,
    hostUnlockVersion: 0,
  };
}

let state: WorkStoreSnapshot = createInitialState();
let hasExplicitProjectChoice = Boolean(state.activeProjectId);
let hasExplicitFilesPanelOpen = false;
let hasExplicitFilesPanelWidth = false;
const listeners = new Set<() => void>();

function emit(next: WorkStoreSnapshot): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getWorkState(): WorkStoreSnapshot {
  return state;
}

export function useWorkState(): WorkStoreSnapshot {
  return useSyncExternalStore(subscribe, getWorkState, getWorkState);
}

export function readActiveProjectId(): string | null {
  return state.activeProjectId ?? readSessionProjectId();
}

export function writeActiveProjectId(projectId: string | null): void {
  hasExplicitProjectChoice = true;
  try {
    if (projectId) globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, projectId);
    else globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
  } catch {
    // Ignore storage restrictions.
  }
  const preferred = projectId ? state.activeTerminalByProject[projectId] : null;
  const nextActiveTerminalId = resolveProjectActiveTerminal(state.terminals, projectId, preferred);
  const nextMap = projectId && nextActiveTerminalId !== preferred
    ? { ...state.activeTerminalByProject, [projectId]: nextActiveTerminalId }
    : state.activeTerminalByProject;
  if (nextMap !== state.activeTerminalByProject) {
    persistActiveTerminals(nextMap);
  }
  if (state.activeProjectId !== projectId || state.activeTerminalId !== nextActiveTerminalId) {
    emit({
      ...state,
      activeProjectId: projectId,
      activeTerminalId: nextActiveTerminalId,
      activeTerminalByProject: nextMap,
    });
  }
}

export function useActiveProjectId(): string | null {
  return useWorkState().activeProjectId;
}

export function setWorkProjects(projects: WorkProject[]): void {
  const activeStillExists = state.activeProjectId ? projects.some((item) => item.id === state.activeProjectId) : false;
  const nextActive = activeStillExists ? state.activeProjectId : (projects[0]?.id ?? null);
  if (nextActive !== state.activeProjectId) {
    try {
      if (nextActive) globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, nextActive);
      else globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
    } catch {
      // Ignore storage restrictions.
    }
  }
  const nextActiveTerminalId = resolveProjectActiveTerminal(
    state.terminals,
    nextActive,
    nextActive ? state.activeTerminalByProject[nextActive] : null,
  );
  emit({
    ...state,
    projects,
    projectsLoaded: true,
    projectsError: null,
    activeProjectId: nextActive,
    activeTerminalId: nextActiveTerminalId,
  });
}

export function setWorkProjectsError(message: string | null): void {
  emit({ ...state, projectsLoaded: true, projectsError: message });
}

export function setWorkHosts(hosts: WorkHost[]): void {
  emit({ ...state, hosts });
}

export function upsertWorkProject(saved: WorkProject): void {
  hasExplicitProjectChoice = true;
  const exists = state.projects.some((item) => item.id === saved.id);
  const nextProjects = exists
    ? state.projects.map((item) => (item.id === saved.id ? saved : item))
    : [saved, ...state.projects];
  try {
    globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, saved.id);
  } catch {
    // Ignore storage restrictions.
  }
  const nextActiveTerminalId = resolveProjectActiveTerminal(
    state.terminals,
    saved.id,
    state.activeTerminalByProject[saved.id],
  );
  emit({
    ...state,
    projects: nextProjects,
    activeProjectId: saved.id,
    activeTerminalId: nextActiveTerminalId,
  });
}

export function removeWorkProject(projectId: string): void {
  const nextProjects = state.projects.filter((item) => item.id !== projectId);
  const nextTerminals = state.terminals.filter((item) => item.projectId !== projectId);
  const nextMap = { ...state.activeTerminalByProject };
  delete nextMap[projectId];
  persistActiveTerminals(nextMap);
  const nextActiveProjectId = state.activeProjectId === projectId
    ? (nextProjects[0]?.id ?? null)
    : state.activeProjectId;
  const nextActiveTerminalId = resolveProjectActiveTerminal(
    nextTerminals,
    nextActiveProjectId,
    nextActiveProjectId ? nextMap[nextActiveProjectId] : null,
  );
  if (nextActiveProjectId !== state.activeProjectId) {
    try {
      if (nextActiveProjectId) globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, nextActiveProjectId);
      else globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
    } catch {
      // Ignore storage restrictions.
    }
  }
  emit({
    ...state,
    projects: nextProjects,
    terminals: nextTerminals,
    activeProjectId: nextActiveProjectId,
    activeTerminalId: nextActiveTerminalId,
    activeTerminalByProject: nextMap,
  });
}

function sortPinnedTerminals(items: readonly WorkTerminalSession[]): WorkTerminalSession[] {
  const pinned: WorkTerminalSession[] = [];
  const unpinned: WorkTerminalSession[] = [];
  for (const item of items) {
    if (item.pinned) pinned.push(item);
    else unpinned.push(item);
  }
  return [...pinned, ...unpinned];
}

export function setWorkTerminals(terminals: WorkTerminalSession[]): void {
  const ordered = sortPinnedTerminals(terminals);
  const nextActiveTerminalId = resolveProjectActiveTerminal(
    ordered,
    state.activeProjectId,
    state.activeProjectId
      ? (state.activeTerminalByProject[state.activeProjectId] ?? state.activeTerminalId)
      : null,
  );
  emit({
    ...state,
    terminals: ordered,
    activeTerminalId: nextActiveTerminalId,
  });
}

export function addWorkTerminal(terminal: WorkTerminalSession): void {
  hasExplicitProjectChoice = true;
  const nextTerminals = sortPinnedTerminals([
    ...state.terminals.filter((item) => item.id !== terminal.id),
    terminal,
  ]);
  const nextMap = {
    ...state.activeTerminalByProject,
    [terminal.projectId]: terminal.id,
  };
  persistActiveTerminals(nextMap);
  try {
    globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, terminal.projectId);
  } catch {
    // Ignore storage restrictions.
  }
  emit({
    ...state,
    terminals: nextTerminals,
    activeTerminalId: terminal.id,
    activeProjectId: terminal.projectId,
    activeTerminalByProject: nextMap,
  });
}

export function replaceWorkTerminalSession(updated: WorkTerminalSession): void {
  const exists = state.terminals.some((item) => item.id === updated.id);
  const nextTerminals = sortPinnedTerminals(
    exists
      ? state.terminals.map((item) => (item.id === updated.id ? updated : item))
      : [...state.terminals, updated],
  );
  emit({
    ...state,
    terminals: nextTerminals,
  });
}

export function updateWorkTerminalMeta(terminalId: string, patch: WorkTerminalPatchInput): void {
  let changed = false;
  const updated = state.terminals.map((item) => {
    if (item.id !== terminalId) return item;
    let nextTitle = item.title;
    if (patch.title !== undefined) {
      const normalized = normalizeWorkTerminalTitle(patch.title);
      nextTitle = normalized;
    }
    const nextPinned = patch.pinned !== undefined ? Boolean(patch.pinned) : Boolean(item.pinned);
    if (nextTitle !== item.title || nextPinned !== Boolean(item.pinned)) {
      changed = true;
      return { ...item, title: nextTitle, pinned: nextPinned };
    }
    return item;
  });
  if (!changed) return;
  emit({
    ...state,
    terminals: sortPinnedTerminals(updated),
  });
}

export function selectWorkTerminal(terminalId: string | null): void {
  if (!terminalId) {
    const nextMap = state.activeProjectId
      ? { ...state.activeTerminalByProject, [state.activeProjectId]: null }
      : state.activeTerminalByProject;
    if (nextMap !== state.activeTerminalByProject) persistActiveTerminals(nextMap);
    emit({ ...state, activeTerminalId: null, activeTerminalByProject: nextMap });
    return;
  }
  const target = state.terminals.find((item) => item.id === terminalId);
  if (!target) return;
  hasExplicitProjectChoice = true;
  const nextMap = {
    ...state.activeTerminalByProject,
    [target.projectId]: terminalId,
  };
  persistActiveTerminals(nextMap);
  try {
    globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, target.projectId);
  } catch {
    // Ignore storage restrictions.
  }
  emit({
    ...state,
    activeTerminalId: terminalId,
    activeProjectId: target.projectId,
    activeTerminalByProject: nextMap,
  });
}

export function updateWorkTerminalStatus(
  terminalId: string,
  status: WorkTerminalStatus,
  exitCode: number | null,
  errorMessage?: string,
  errorCode?: string,
): void {
  emit({
    ...state,
    terminals: state.terminals.map((item) => (
      item.id === terminalId
        ? {
            ...item,
            status,
            exitCode,
            ...(errorMessage !== undefined ? { errorMessage } : { errorMessage: undefined }),
            ...(errorCode !== undefined ? { errorCode } : { errorCode: undefined }),
          }
        : item
    )),
  });
}

export function removeWorkTerminal(terminalId: string): void {
  removeWorkTerminals([terminalId]);
}

export function removeWorkTerminals(terminalIds: readonly string[]): void {
  const targets = new Set(terminalIds);
  if (targets.size === 0) return;
  const existing = state.terminals;
  if (!existing.some((item) => targets.has(item.id))) return;

  const nextTerminals = existing.filter((item) => !targets.has(item.id));
  const nextMap = { ...state.activeTerminalByProject };
  for (const [projectId, storedId] of Object.entries(nextMap)) {
    if (storedId && targets.has(storedId)) {
      nextMap[projectId] = resolveProjectActiveTerminal(nextTerminals, projectId);
    }
  }

  const activeProjectId = state.activeProjectId;
  let nextActive = state.activeTerminalId;
  if (activeProjectId) {
    const projectBefore = existing.filter((item) => item.projectId === activeProjectId);
    const removedIdx = projectBefore.findIndex((item) => targets.has(item.id));
    const projectAfter = nextTerminals.filter((item) => item.projectId === activeProjectId);
    if (!nextActive || targets.has(nextActive) || !projectAfter.some((item) => item.id === nextActive)) {
      const idx = removedIdx === -1 ? 0 : Math.min(removedIdx, projectAfter.length - 1);
      nextActive = projectAfter[idx]?.id ?? null;
    }
    nextMap[activeProjectId] = nextActive;
  } else if (nextActive && targets.has(nextActive)) {
    nextActive = null;
  }
  persistActiveTerminals(nextMap);

  emit({
    ...state,
    terminals: nextTerminals,
    activeTerminalId: nextActive,
    activeTerminalByProject: nextMap,
  });
}

export function toggleWorkFilesPanel(open?: boolean): void {
  hasExplicitFilesPanelOpen = true;
  const next = open !== undefined ? open : !state.filesPanelOpen;
  if (next === state.filesPanelOpen) return;
  emit({ ...state, filesPanelOpen: next });
}

export function setWorkFilesPanelWidth(width: number | null, maxWidth = MAX_WORK_FILES_WIDTH): void {
  hasExplicitFilesPanelWidth = true;
  const next = width === null ? null : clampWorkFilesWidth(width, maxWidth);
  try {
    if (next === null) globalThis.localStorage?.removeItem(FILES_PANEL_WIDTH_KEY);
    else globalThis.localStorage?.setItem(FILES_PANEL_WIDTH_KEY, String(next));
  } catch {
    // Ignore storage restrictions.
  }
  if (next !== state.filesPanelWidth) {
    emit({ ...state, filesPanelWidth: next });
  }
}

export function setWorkServerPlatform(platform: string | null): void {
  if (state.serverPlatform === platform) return;
  emit({ ...state, serverPlatform: platform });
}

export function setDefaultWindowsShell(shell: WindowsTerminalShell, loaded = true): void {
  const normalized = normalizeOptionalWindowsShell(shell) ?? DEFAULT_WINDOWS_SHELL;
  try {
    globalThis.localStorage?.setItem(DEFAULT_WINDOWS_SHELL_KEY, normalized);
  } catch {
    // Ignore storage restrictions.
  }
  if (state.defaultWindowsShell === normalized && state.defaultWindowsShellLoaded === loaded) return;
  emit({
    ...state,
    defaultWindowsShell: normalized,
    defaultWindowsShellLoaded: loaded,
  });
}

export function hydrateWorkSettings(settings: {
  defaultWindowsShell: WindowsTerminalShell;
  activeProjectId: string | null;
  activeTerminals: Record<string, string | null>;
  filesPanelOpen?: boolean;
  filesPanelWidth?: number | null;
}): void {
  const normalizedShell = normalizeOptionalWindowsShell(settings.defaultWindowsShell) ?? DEFAULT_WINDOWS_SHELL;
  const mergedTerminals = {
    ...state.activeTerminalByProject,
    ...settings.activeTerminals,
  };
  persistActiveTerminals(mergedTerminals);
  try {
    globalThis.localStorage?.setItem(DEFAULT_WINDOWS_SHELL_KEY, normalizedShell);
  } catch {
    // Ignore storage restrictions.
  }

  // Only keep an existing activeProjectId if the user explicitly switched/selected one
  // in this session; otherwise restore the server-persisted activeProjectId from SQLite.
  let nextActiveProjectId = state.activeProjectId;
  if (!hasExplicitProjectChoice && settings.activeProjectId) {
    const exists = state.projects.length === 0
      || state.projects.some((item) => item.id === settings.activeProjectId);
    if (exists) nextActiveProjectId = settings.activeProjectId;
  }
  if (nextActiveProjectId && nextActiveProjectId !== state.activeProjectId) {
    try {
      globalThis.sessionStorage?.setItem(ACTIVE_PROJECT_KEY, nextActiveProjectId);
    } catch {
      // Ignore storage restrictions.
    }
  }
  const nextActiveTerminalId = resolveProjectActiveTerminal(
    state.terminals,
    nextActiveProjectId,
    nextActiveProjectId ? mergedTerminals[nextActiveProjectId] : null,
  );
  const nextFilesPanelOpen = !hasExplicitFilesPanelOpen && settings.filesPanelOpen !== undefined
    ? Boolean(settings.filesPanelOpen)
    : state.filesPanelOpen;
  let nextFilesPanelWidth = state.filesPanelWidth;
  if (!hasExplicitFilesPanelWidth && settings.filesPanelWidth !== undefined) {
    nextFilesPanelWidth = settings.filesPanelWidth === null
      ? null
      : clampWorkFilesWidth(settings.filesPanelWidth);
    try {
      if (nextFilesPanelWidth === null) globalThis.localStorage?.removeItem(FILES_PANEL_WIDTH_KEY);
      else globalThis.localStorage?.setItem(FILES_PANEL_WIDTH_KEY, String(nextFilesPanelWidth));
    } catch {
      // Ignore storage restrictions.
    }
  }
  emit({
    ...state,
    defaultWindowsShell: normalizedShell,
    defaultWindowsShellLoaded: true,
    activeProjectId: nextActiveProjectId,
    activeTerminalId: nextActiveTerminalId,
    activeTerminalByProject: mergedTerminals,
    filesPanelOpen: nextFilesPanelOpen,
    filesPanelWidth: nextFilesPanelWidth,
  });
}

export function setWorkPlatformForTests(platform: string | null): void {
  emit({ ...state, serverPlatform: platform });
}

export function bumpHostUnlockVersion(): void {
  emit({ ...state, hostUnlockVersion: state.hostUnlockVersion + 1 });
}

export function resetWorkStateForTests(): void {
  hasExplicitProjectChoice = false;
  hasExplicitFilesPanelOpen = false;
  hasExplicitFilesPanelWidth = false;
  try {
    globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
    globalThis.localStorage?.removeItem(ACTIVE_TERMINALS_KEY);
    globalThis.localStorage?.removeItem(FILES_PANEL_WIDTH_KEY);
    globalThis.localStorage?.removeItem(DEFAULT_WINDOWS_SHELL_KEY);
  } catch {
    // Ignore storage failures in tests.
  }
  emit({
    activeProjectId: null,
    projects: [],
    projectsLoaded: false,
    projectsError: null,
    hosts: [],
    terminals: [],
    activeTerminalId: null,
    activeTerminalByProject: {},
    filesPanelOpen: true,
    filesPanelWidth: null,
    serverPlatform: null,
    defaultWindowsShell: DEFAULT_WINDOWS_SHELL,
    defaultWindowsShellLoaded: false,
    hostUnlockVersion: 0,
  });
}
