import {
  CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
  CLI_SESSIONS_INITIAL_VISIBLE,
  CLI_SESSIONS_PAGE_STEP,
  WORK_CLI_PROVIDERS,
  normalizeWorkCliProviderOrder,
  reorderStringList,
  workCliGroupKey,
  type WorkCliProvider,
  type WorkCliSession,
  type WorkProjectCliSessionsResponse,
} from '@contract/work-cli';
import type { WorkHost } from '@contract/work-hosts';
import {
  normalizeWorkProjectOrder,
  sortWorkProjectsByOrder,
  type WorkProject,
} from '@contract/work-projects';
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
const EXPANDED_PROJECTS_KEY = 'matrius:work-expanded-projects';
const PROJECT_ORDER_KEY = 'matrius:work-project-order';
const CLI_PROVIDER_ORDER_KEY = 'matrius:work-cli-provider-order';
const COLLAPSED_CLI_GROUPS_KEY = 'matrius:work-collapsed-cli-groups';
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

export type WorkProjectCliSessionsState = {
  items: WorkCliSession[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  loaded: boolean;
  error: string | null;
  requestedLimit: number;
};

export type WorkStoreSnapshot = {
  activeProjectId: string | null;
  projects: WorkProject[];
  projectsLoaded: boolean;
  projectsError: string | null;
  projectOrder: string[];
  cliProviderOrder: WorkCliProvider[];
  expandedProjectIds: Record<string, boolean>;
  collapsedCliGroups: Record<string, boolean>;
  cliVisibleCounts: Record<string, number>;
  cliSessionsByProject: Record<string, WorkProjectCliSessionsState>;
  unreadCompletedCliKeys: Record<string, boolean>;
  cliRefreshTick: number;
  hosts: WorkHost[];
  terminals: WorkTerminalSession[];
  activeTerminalId: string | null;
  activeTerminalByProject: Record<string, string | null>;
  filesPanelOpen: boolean;
  filesPanelWidth: number | null;
  serverPlatform: string | null;
  windowsBuild: number | null;
  defaultWindowsShell: WindowsTerminalShell;
  defaultWindowsShellLoaded: boolean;
  persistTerminalScrollback: boolean;
  hostUnlockVersion: number;
};

export function workCliSessionKey(
  projectId: string,
  provider: WorkCliProvider,
  sessionId: string,
): string {
  return `${projectId}:${provider}:${sessionId}`;
}

function readStoredJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function persistStoredJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage restrictions.
  }
}

function readStoredBooleanMap(key: string): Record<string, boolean> {
  const parsed = readStoredJson(key);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const next: Record<string, boolean> = {};
  for (const [entryKey, value] of Object.entries(parsed)) {
    if (value === true && entryKey.trim()) next[entryKey] = true;
  }
  return next;
}

function readStoredExpandedProjects(): Record<string, boolean> {
  return readStoredBooleanMap(EXPANDED_PROJECTS_KEY);
}

function persistExpandedProjects(map: Record<string, boolean>): void {
  persistStoredJson(EXPANDED_PROJECTS_KEY, map);
}

function readStoredProjectOrder(): string[] {
  const parsed = readStoredJson(PROJECT_ORDER_KEY);
  return Array.isArray(parsed) ? normalizeWorkProjectOrder(parsed) : [];
}

function readStoredCliProviderOrder(): WorkCliProvider[] {
  const parsed = readStoredJson(CLI_PROVIDER_ORDER_KEY);
  return Array.isArray(parsed) ? normalizeWorkCliProviderOrder(parsed) : [...WORK_CLI_PROVIDERS];
}

function readStoredCollapsedCliGroups(): Record<string, boolean> {
  return readStoredBooleanMap(COLLAPSED_CLI_GROUPS_KEY);
}

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
    projectOrder: readStoredProjectOrder(),
    cliProviderOrder: readStoredCliProviderOrder(),
    expandedProjectIds: readStoredExpandedProjects(),
    collapsedCliGroups: readStoredCollapsedCliGroups(),
    cliVisibleCounts: {},
    cliSessionsByProject: {},
    unreadCompletedCliKeys: {},
    cliRefreshTick: 0,
    hosts: [],
    terminals: [],
    activeTerminalId: null,
    activeTerminalByProject: readStoredActiveTerminals(),
    filesPanelOpen: true,
    filesPanelWidth: readStoredFilesWidth(),
    serverPlatform: null,
    windowsBuild: null,
    defaultWindowsShell: readStoredDefaultWindowsShell(),
    defaultWindowsShellLoaded: false,
    persistTerminalScrollback: false,
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
  const orderedProjects = sortWorkProjectsByOrder(projects, state.projectOrder);
  const activeStillExists = state.activeProjectId
    ? orderedProjects.some((item) => item.id === state.activeProjectId)
    : false;
  const nextActive = activeStillExists ? state.activeProjectId : (orderedProjects[0]?.id ?? null);
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
    projects: orderedProjects,
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
  let nextProjectOrder = state.projectOrder;
  if (!exists && state.projectOrder.length > 0) {
    nextProjectOrder = [saved.id, ...state.projectOrder.filter((id) => id !== saved.id)];
    persistStoredJson(PROJECT_ORDER_KEY, nextProjectOrder);
  }
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
    projectOrder: nextProjectOrder,
    activeProjectId: saved.id,
    activeTerminalId: nextActiveTerminalId,
  });
}

export function removeWorkProject(projectId: string): void {
  const nextProjects = state.projects.filter((item) => item.id !== projectId);
  const nextProjectOrder = state.projectOrder.filter((id) => id !== projectId);
  if (nextProjectOrder.length !== state.projectOrder.length) {
    persistStoredJson(PROJECT_ORDER_KEY, nextProjectOrder);
  }
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
  const nextExpanded = { ...state.expandedProjectIds };
  delete nextExpanded[projectId];
  persistExpandedProjects(nextExpanded);
  const prefix = `${projectId}:`;
  const nextCollapsedCliGroups = { ...state.collapsedCliGroups };
  for (const key of Object.keys(nextCollapsedCliGroups)) {
    if (key.startsWith(prefix)) delete nextCollapsedCliGroups[key];
  }
  persistStoredJson(COLLAPSED_CLI_GROUPS_KEY, nextCollapsedCliGroups);
  const nextCliVisible = { ...state.cliVisibleCounts };
  for (const key of Object.keys(nextCliVisible)) {
    if (key === projectId || key.startsWith(prefix)) delete nextCliVisible[key];
  }
  const nextCliSessions = { ...state.cliSessionsByProject };
  delete nextCliSessions[projectId];
  const nextUnread = { ...state.unreadCompletedCliKeys };
  for (const key of Object.keys(nextUnread)) {
    if (key.startsWith(prefix)) delete nextUnread[key];
  }
  emit({
    ...state,
    projects: nextProjects,
    projectOrder: nextProjectOrder,
    expandedProjectIds: nextExpanded,
    collapsedCliGroups: nextCollapsedCliGroups,
    cliVisibleCounts: nextCliVisible,
    cliSessionsByProject: nextCliSessions,
    unreadCompletedCliKeys: nextUnread,
    terminals: nextTerminals,
    activeProjectId: nextActiveProjectId,
    activeTerminalId: nextActiveTerminalId,
    activeTerminalByProject: nextMap,
  });
}

export function reorderWorkProjects(
  draggedId: string,
  targetId: string,
  position?: 'before' | 'after',
): void {
  const currentIds = state.projects.map((item) => item.id);
  const nextOrder = reorderStringList(currentIds, draggedId, targetId, position);
  if (nextOrder.length === currentIds.length && nextOrder.every((id, index) => id === currentIds[index])) {
    return;
  }
  persistStoredJson(PROJECT_ORDER_KEY, nextOrder);
  emit({
    ...state,
    projectOrder: nextOrder,
    projects: sortWorkProjectsByOrder(state.projects, nextOrder),
  });
}

export function reorderWorkCliProviders(
  draggedProvider: WorkCliProvider,
  targetProvider: WorkCliProvider,
  position?: 'before' | 'after',
): void {
  const nextOrder = normalizeWorkCliProviderOrder(
    reorderStringList(state.cliProviderOrder, draggedProvider, targetProvider, position),
  );
  if (nextOrder.every((provider, index) => provider === state.cliProviderOrder[index])) {
    return;
  }
  persistStoredJson(CLI_PROVIDER_ORDER_KEY, nextOrder);
  emit({
    ...state,
    cliProviderOrder: nextOrder,
  });
}

export function toggleWorkCliGroupCollapsed(projectId: string, provider: WorkCliProvider): void {
  const key = workCliGroupKey(projectId, provider);
  const next = { ...state.collapsedCliGroups };
  if (next[key]) delete next[key];
  else next[key] = true;
  persistStoredJson(COLLAPSED_CLI_GROUPS_KEY, next);
  emit({
    ...state,
    collapsedCliGroups: next,
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
  const nextUnread = { ...state.unreadCompletedCliKeys };
  if (terminal.preset !== 'shell' && terminal.cliSessionId) {
    delete nextUnread[workCliSessionKey(terminal.projectId, terminal.preset, terminal.cliSessionId)];
  }
  emit({
    ...state,
    terminals: nextTerminals,
    activeTerminalId: terminal.id,
    activeProjectId: terminal.projectId,
    activeTerminalByProject: nextMap,
    unreadCompletedCliKeys: nextUnread,
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
  const nextUnread = { ...state.unreadCompletedCliKeys };
  if (target.preset !== 'shell' && target.cliSessionId) {
    delete nextUnread[workCliSessionKey(target.projectId, target.preset, target.cliSessionId)];
  }
  emit({
    ...state,
    activeTerminalId: terminalId,
    activeProjectId: target.projectId,
    activeTerminalByProject: nextMap,
    unreadCompletedCliKeys: nextUnread,
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

export function setWorkServerPlatform(platform: string | null, windowsBuild?: number | null): void {
  const nextBuild = windowsBuild !== undefined ? windowsBuild : state.windowsBuild;
  if (state.serverPlatform === platform && state.windowsBuild === nextBuild) return;
  emit({ ...state, serverPlatform: platform, windowsBuild: nextBuild });
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

export function setPersistTerminalScrollback(enabled: boolean): void {
  const next = Boolean(enabled);
  if (state.persistTerminalScrollback === next) return;
  emit({ ...state, persistTerminalScrollback: next });
}

export function hydrateWorkSettings(settings: {
  defaultWindowsShell: WindowsTerminalShell;
  activeProjectId: string | null;
  activeTerminals: Record<string, string | null>;
  filesPanelOpen?: boolean;
  filesPanelWidth?: number | null;
  persistTerminalScrollback?: boolean;
  projectOrder?: string[];
  cliProviderOrder?: WorkCliProvider[];
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

  const nextProjectOrder = settings.projectOrder !== undefined
    ? normalizeWorkProjectOrder(settings.projectOrder)
    : state.projectOrder;
  const nextCliProviderOrder = settings.cliProviderOrder !== undefined
    ? normalizeWorkCliProviderOrder(settings.cliProviderOrder)
    : state.cliProviderOrder;
  if (settings.projectOrder !== undefined) persistStoredJson(PROJECT_ORDER_KEY, nextProjectOrder);
  if (settings.cliProviderOrder !== undefined) persistStoredJson(CLI_PROVIDER_ORDER_KEY, nextCliProviderOrder);

  const orderedProjects = sortWorkProjectsByOrder(state.projects, nextProjectOrder);

  // Only keep an existing activeProjectId if the user explicitly switched/selected one
  // in this session; otherwise restore the server-persisted activeProjectId from SQLite.
  let nextActiveProjectId = state.activeProjectId;
  if (!hasExplicitProjectChoice && settings.activeProjectId) {
    const exists = orderedProjects.length === 0
      || orderedProjects.some((item) => item.id === settings.activeProjectId);
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
    projects: orderedProjects,
    projectOrder: nextProjectOrder,
    cliProviderOrder: nextCliProviderOrder,
    defaultWindowsShell: normalizedShell,
    defaultWindowsShellLoaded: true,
    persistTerminalScrollback: Boolean(settings.persistTerminalScrollback),
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

export function bumpCliSessionsRefresh(): void {
  emit({ ...state, cliRefreshTick: state.cliRefreshTick + 1 });
}

export function isWorkProjectExpanded(projectId: string): boolean {
  return Boolean(state.expandedProjectIds[projectId]);
}

export function setWorkProjectExpanded(projectId: string, expanded: boolean): void {
  const current = Boolean(state.expandedProjectIds[projectId]);
  if (current === expanded) return;
  const next = { ...state.expandedProjectIds };
  if (expanded) next[projectId] = true;
  else delete next[projectId];
  persistExpandedProjects(next);
  emit({ ...state, expandedProjectIds: next });
}

export function toggleWorkProjectExpanded(projectId: string): void {
  setWorkProjectExpanded(projectId, !state.expandedProjectIds[projectId]);
}

export function showMoreWorkCliSessions(
  projectId: string,
  provider: WorkCliProvider,
  step = CLI_SESSIONS_PAGE_STEP,
): number {
  const groupKey = workCliGroupKey(projectId, provider);
  const current = state.cliVisibleCounts[groupKey] ?? CLI_SESSIONS_INITIAL_VISIBLE;
  const next = current + Math.max(1, step);
  emit({
    ...state,
    cliVisibleCounts: { ...state.cliVisibleCounts, [groupKey]: next },
  });
  return next;
}

export function collapseWorkCliSessions(projectId: string, provider: WorkCliProvider): void {
  const groupKey = workCliGroupKey(projectId, provider);
  if (!(groupKey in state.cliVisibleCounts)) {
    return;
  }
  const nextCounts = { ...state.cliVisibleCounts };
  delete nextCounts[groupKey];
  emit({
    ...state,
    cliVisibleCounts: nextCounts,
  });
}

export function setWorkProjectCliSessionsLoading(
  projectId: string,
  options: { loadingMore?: boolean; requestedLimit?: number } = {},
): void {
  const prev = state.cliSessionsByProject[projectId];
  const requestedLimit = options.requestedLimit ?? prev?.requestedLimit ?? CLI_SESSIONS_DEFAULT_FETCH_LIMIT;
  emit({
    ...state,
    cliSessionsByProject: {
      ...state.cliSessionsByProject,
      [projectId]: {
        items: prev?.items ?? [],
        total: prev?.total ?? 0,
        hasMore: prev?.hasMore ?? false,
        loading: !options.loadingMore && !prev?.loaded,
        loadingMore: Boolean(options.loadingMore),
        loaded: prev?.loaded ?? false,
        error: null,
        requestedLimit,
      },
    },
  });
}

export function setWorkProjectCliSessions(
  projectId: string,
  payload: WorkProjectCliSessionsResponse,
  requestedLimit = CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
): void {
  const prev = state.cliSessionsByProject[projectId];
  const prevByKey = new Map<string, WorkCliSession>();
  for (const item of prev?.items ?? []) {
    prevByKey.set(workCliSessionKey(projectId, item.provider, item.id), item);
  }
  const activeTerm = state.activeTerminalId
    ? state.terminals.find((item) => item.id === state.activeTerminalId) ?? null
    : null;

  let unreadChanged = false;
  const nextUnread = { ...state.unreadCompletedCliKeys };
  for (const item of payload.items) {
    const key = workCliSessionKey(projectId, item.provider, item.id);
    const prevItem = prevByKey.get(key);
    const isCurrentlyViewed = state.activeProjectId === projectId
      && activeTerm?.preset === item.provider
      && activeTerm?.cliSessionId === item.id;
    if (item.status === 'running') {
      if (nextUnread[key]) {
        delete nextUnread[key];
        unreadChanged = true;
      }
    } else if (
      item.status === 'completed'
      && prevItem?.status === 'running'
      && !isCurrentlyViewed
    ) {
      if (!nextUnread[key]) {
        nextUnread[key] = true;
        unreadChanged = true;
      }
    }
  }

  emit({
    ...state,
    cliSessionsByProject: {
      ...state.cliSessionsByProject,
      [projectId]: {
        items: payload.items,
        total: payload.total,
        hasMore: payload.hasMore,
        loading: false,
        loadingMore: false,
        loaded: true,
        error: null,
        requestedLimit,
      },
    },
    ...(unreadChanged ? { unreadCompletedCliKeys: nextUnread } : {}),
  });
}

export function setWorkProjectCliSessionsError(projectId: string, message: string): void {
  const prev = state.cliSessionsByProject[projectId];
  emit({
    ...state,
    cliSessionsByProject: {
      ...state.cliSessionsByProject,
      [projectId]: {
        items: prev?.items ?? [],
        total: prev?.total ?? 0,
        hasMore: prev?.hasMore ?? false,
        loading: false,
        loadingMore: false,
        loaded: prev?.loaded ?? true,
        error: message,
        requestedLimit: prev?.requestedLimit ?? CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
      },
    },
  });
}

export function markWorkCliSessionRead(
  projectId: string,
  provider: WorkCliProvider,
  sessionId: string,
): void {
  const key = workCliSessionKey(projectId, provider, sessionId);
  if (!state.unreadCompletedCliKeys[key]) return;
  const next = { ...state.unreadCompletedCliKeys };
  delete next[key];
  emit({ ...state, unreadCompletedCliKeys: next });
}

export function resetWorkStateForTests(): void {
  hasExplicitProjectChoice = false;
  hasExplicitFilesPanelOpen = false;
  hasExplicitFilesPanelWidth = false;
  try {
    globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
    globalThis.localStorage?.removeItem(ACTIVE_TERMINALS_KEY);
    globalThis.localStorage?.removeItem(EXPANDED_PROJECTS_KEY);
    globalThis.localStorage?.removeItem(PROJECT_ORDER_KEY);
    globalThis.localStorage?.removeItem(CLI_PROVIDER_ORDER_KEY);
    globalThis.localStorage?.removeItem(COLLAPSED_CLI_GROUPS_KEY);
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
    projectOrder: [],
    cliProviderOrder: [...WORK_CLI_PROVIDERS],
    expandedProjectIds: {},
    collapsedCliGroups: {},
    cliVisibleCounts: {},
    cliSessionsByProject: {},
    unreadCompletedCliKeys: {},
    cliRefreshTick: 0,
    hosts: [],
    terminals: [],
    activeTerminalId: null,
    activeTerminalByProject: {},
    filesPanelOpen: true,
    filesPanelWidth: null,
    serverPlatform: null,
    windowsBuild: null,
    defaultWindowsShell: DEFAULT_WINDOWS_SHELL,
    defaultWindowsShellLoaded: false,
    persistTerminalScrollback: false,
    hostUnlockVersion: 0,
  });
}
