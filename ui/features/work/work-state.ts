import {
  CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
  CLI_SESSIONS_INITIAL_VISIBLE,
  CLI_SESSIONS_PAGE_STEP,
  WORK_CLI_PROVIDERS,
  buildCliResumeCommand,
  formatCliTerminalTitle,
  isFallbackCliSessionTitle,
  normalizeWorkCliProviderOrder,
  reorderStringList,
  workCliGroupKey,
  type WorkCliProvider,
  type WorkCliSession,
  type WorkProjectCliSessionsResponse,
} from '@contract/work-cli';
import type { WorkHost } from '@contract/work-hosts';
import {
  DEFAULT_WORK_EDITOR_FONT_SIZE,
  normalizeWorkEditorDiffLayout,
  normalizeWorkEditorFontSize,
  type WorkEditorDiffLayout,
  normalizeWorkProjectOrder,
  sortWorkProjectsByOrder,
  type HostFilePreview,
  workFileTabPath,
  type WorkFileTab,
  type WorkProject,
} from '@contract/work-projects';
import {
  DEFAULT_WINDOWS_SHELL,
  normalizeOptionalWindowsShell,
  normalizeWorkTerminalOrder,
  normalizeWorkTerminalTitle,
  sortWorkTerminalsByOrder,
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
const TERMINAL_ORDER_KEY = 'matrius:work-terminal-order';
const COLLAPSED_CLI_GROUPS_KEY = 'matrius:work-collapsed-cli-groups';
const PROJECT_AI_EXPANDED_GROUPS_KEY = 'matrius:work-project-ai-expanded-groups';
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
  terminalOrder: string[];
  expandedProjectIds: Record<string, boolean>;
  collapsedCliGroups: Record<string, boolean>;
  projectAiExpandedGroups: Record<WorkCliProvider, boolean>;
  cliVisibleCounts: Record<string, number>;
  cliSessionsByProject: Record<string, WorkProjectCliSessionsState>;
  unreadCompletedCliKeys: Record<string, boolean>;
  cliRefreshTick: number;
  hosts: WorkHost[];
  terminals: WorkTerminalSession[];
  gitTabsByProject: Record<string, 'active' | 'inactive'>;
  fileTabsByProject: Record<string, { entries: WorkFileTab[]; activePath: string | null; drafts: Map<string, WorkFileDraft> }>;
  activeTerminalId: string | null;
  activeTerminalByProject: Record<string, string | null>;
  filesPanelOpen: boolean;
  filesPanelWidth: number | null;
  fileSearchProjectId: string | null;
  serverPlatform: string | null;
  windowsBuild: number | null;
  defaultWindowsShell: WindowsTerminalShell;
  defaultWindowsShellLoaded: boolean;
  persistTerminalScrollback: boolean;
  editorFontSize: number;
  editorAutoSave: boolean;
  editorDiffLayout: WorkEditorDiffLayout;
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

function readStoredTerminalOrder(): string[] {
  const parsed = readStoredJson(TERMINAL_ORDER_KEY);
  return Array.isArray(parsed) ? normalizeWorkTerminalOrder(parsed) : [];
}

function readStoredCollapsedCliGroups(): Record<string, boolean> {
  return readStoredBooleanMap(COLLAPSED_CLI_GROUPS_KEY);
}

function defaultProjectAiExpandedGroups(): Record<WorkCliProvider, boolean> {
  return { codex: false, antigravity: false, claude: false };
}

function readStoredProjectAiExpandedGroups(): Record<WorkCliProvider, boolean> {
  const map = readStoredBooleanMap(PROJECT_AI_EXPANDED_GROUPS_KEY);
  return {
    codex: Boolean(map.codex),
    antigravity: Boolean(map.antigravity),
    claude: Boolean(map.claude),
  };
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
    terminalOrder: readStoredTerminalOrder(),
    expandedProjectIds: readStoredExpandedProjects(),
    collapsedCliGroups: readStoredCollapsedCliGroups(),
    projectAiExpandedGroups: readStoredProjectAiExpandedGroups(),
    cliVisibleCounts: {},
    cliSessionsByProject: {},
    unreadCompletedCliKeys: {},
    cliRefreshTick: 0,
    hosts: [],
    terminals: [],
    gitTabsByProject: {},
    fileTabsByProject: {},
    activeTerminalId: null,
    activeTerminalByProject: readStoredActiveTerminals(),
    filesPanelOpen: true,
    filesPanelWidth: readStoredFilesWidth(),
    fileSearchProjectId: null,
    serverPlatform: null,
    windowsBuild: null,
    defaultWindowsShell: readStoredDefaultWindowsShell(),
    defaultWindowsShellLoaded: false,
    persistTerminalScrollback: false,
    editorFontSize: DEFAULT_WORK_EDITOR_FONT_SIZE,
    editorAutoSave: false,
    editorDiffLayout: 'inline',
    hostUnlockVersion: 0,
  };
}

let state: WorkStoreSnapshot = createInitialState();
let hasExplicitProjectChoice = Boolean(state.activeProjectId);
let lastHydratedActiveProjectId: string | null = null;
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
  const activeTerminal = nextActiveTerminalId
    ? state.terminals.find((item) => item.id === nextActiveTerminalId) ?? null
    : null;
  let unreadChanged = false;
  let nextUnread = state.unreadCompletedCliKeys;
  if (activeTerminal && activeTerminal.preset !== 'shell' && activeTerminal.cliSessionId) {
    const key = workCliSessionKey(activeTerminal.projectId, activeTerminal.preset, activeTerminal.cliSessionId);
    if (nextUnread[key]) {
      nextUnread = { ...nextUnread };
      delete nextUnread[key];
      unreadChanged = true;
    }
  }
  if (state.activeProjectId !== projectId || state.activeTerminalId !== nextActiveTerminalId || unreadChanged) {
    emit({
      ...state,
      activeProjectId: projectId,
      activeTerminalId: nextActiveTerminalId,
      activeTerminalByProject: nextMap,
      ...(state.activeProjectId !== projectId ? { fileSearchProjectId: null } : {}),
      ...(unreadChanged ? { unreadCompletedCliKeys: nextUnread } : {}),
    });
  }
}

export function openWorkFileSearch(projectId?: string | null): void {
  const target = projectId ?? state.activeProjectId ?? state.projects[0]?.id ?? null;
  if (!target || state.fileSearchProjectId === target) return;
  emit({ ...state, fileSearchProjectId: target });
}

export function closeWorkFileSearch(): void {
  if (state.fileSearchProjectId === null) return;
  emit({ ...state, fileSearchProjectId: null });
}

export function selectWorkProjectFromRoute(projectId: string): void {
  writeActiveProjectId(projectId);
}

export function useActiveProjectId(): string | null {
  return useWorkState().activeProjectId;
}

export function setWorkProjects(projects: WorkProject[]): void {
  const orderedProjects = sortWorkProjectsByOrder(projects, state.projectOrder);
  const activeStillExists = state.activeProjectId
    ? orderedProjects.some((item) => item.id === state.activeProjectId)
    : false;
  const fallbackActive = lastHydratedActiveProjectId
    && orderedProjects.some((item) => item.id === lastHydratedActiveProjectId)
    ? lastHydratedActiveProjectId
    : (orderedProjects[0]?.id ?? null);
  const nextActive = activeStillExists ? state.activeProjectId : fallbackActive;
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
  const removedTerminalIds = new Set(
    state.terminals.filter((item) => item.projectId === projectId).map((item) => item.id),
  );
  const nextTerminals = state.terminals.filter((item) => item.projectId !== projectId);
  const nextTerminalOrder = removedTerminalIds.size > 0
    ? state.terminalOrder.filter((id) => !removedTerminalIds.has(id))
    : state.terminalOrder;
  if (nextTerminalOrder.length !== state.terminalOrder.length) {
    persistStoredJson(TERMINAL_ORDER_KEY, nextTerminalOrder);
  }
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
  const fileTabsByProject = { ...state.fileTabsByProject };
  delete fileTabsByProject[projectId];
  const gitTabsByProject = { ...state.gitTabsByProject };
  delete gitTabsByProject[projectId];
  emit({
    ...state,
    fileTabsByProject,
    gitTabsByProject,
    projects: nextProjects,
    projectOrder: nextProjectOrder,
    expandedProjectIds: nextExpanded,
    collapsedCliGroups: nextCollapsedCliGroups,
    cliVisibleCounts: nextCliVisible,
    cliSessionsByProject: nextCliSessions,
    unreadCompletedCliKeys: nextUnread,
    terminals: nextTerminals,
    terminalOrder: nextTerminalOrder,
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

export function setWorkCliGroupCollapsed(
  projectId: string,
  provider: WorkCliProvider,
  collapsed: boolean,
): void {
  const key = workCliGroupKey(projectId, provider);
  const current = Boolean(state.collapsedCliGroups[key]);
  if (current === collapsed) return;
  const next = { ...state.collapsedCliGroups };
  if (collapsed) next[key] = true;
  else delete next[key];
  persistStoredJson(COLLAPSED_CLI_GROUPS_KEY, next);
  emit({
    ...state,
    collapsedCliGroups: next,
  });
}

export function toggleWorkCliGroupCollapsed(projectId: string, provider: WorkCliProvider): void {
  const key = workCliGroupKey(projectId, provider);
  setWorkCliGroupCollapsed(projectId, provider, !state.collapsedCliGroups[key]);
}

export function setWorkProjectAiGroupExpanded(provider: WorkCliProvider, expanded: boolean): void {
  if (Boolean(state.projectAiExpandedGroups[provider]) === expanded) return;
  const next: Record<WorkCliProvider, boolean> = {
    ...state.projectAiExpandedGroups,
    [provider]: expanded,
  };
  persistStoredJson(PROJECT_AI_EXPANDED_GROUPS_KEY, next);
  emit({
    ...state,
    projectAiExpandedGroups: next,
  });
}

export function toggleWorkProjectAiGroupExpanded(provider: WorkCliProvider): void {
  setWorkProjectAiGroupExpanded(provider, !state.projectAiExpandedGroups[provider]);
}

export function reorderWorkTerminals(
  draggedId: string,
  targetId: string,
  position?: 'before' | 'after',
): void {
  const dragged = state.terminals.find((item) => item.id === draggedId);
  const target = state.terminals.find((item) => item.id === targetId);
  if (!dragged || !target || dragged.id === target.id) return;
  if (dragged.projectId !== target.projectId) return;
  if (Boolean(dragged.pinned) !== Boolean(target.pinned)) return;

  const currentIds = state.terminals.map((item) => item.id);
  const nextIds = reorderStringList(currentIds, draggedId, targetId, position);
  if (nextIds.length === currentIds.length && nextIds.every((id, index) => id === currentIds[index])) {
    return;
  }
  const nextTerminals = sortWorkTerminalsByOrder(state.terminals, nextIds);
  const nextTerminalOrder = nextTerminals.map((item) => item.id);
  persistStoredJson(TERMINAL_ORDER_KEY, nextTerminalOrder);
  emit({
    ...state,
    terminalOrder: nextTerminalOrder,
    terminals: nextTerminals,
  });
}

let draftBaselineSessionIdsByTerminalId = new Map<string, Set<string>>();
let lastAutoTitleByTerminalId = new Map<string, string>();
let manuallyRenamedTerminalIds = new Set<string>();

function pruneTerminalTracking(activeTerminals: readonly WorkTerminalSession[]): void {
  const activeIds = new Set(activeTerminals.map((item) => item.id));
  for (const id of draftBaselineSessionIdsByTerminalId.keys()) {
    if (!activeIds.has(id)) draftBaselineSessionIdsByTerminalId.delete(id);
  }
  for (const id of lastAutoTitleByTerminalId.keys()) {
    if (!activeIds.has(id)) lastAutoTitleByTerminalId.delete(id);
  }
  for (const id of manuallyRenamedTerminalIds) {
    if (!activeIds.has(id)) manuallyRenamedTerminalIds.delete(id);
  }
}

export function setWorkTerminals(terminals: WorkTerminalSession[]): void {
  const ordered = sortWorkTerminalsByOrder(terminals, state.terminalOrder);
  pruneTerminalTracking(ordered);
  for (const item of ordered) {
    if (item.preset !== 'shell' && !item.cliSessionId && !draftBaselineSessionIdsByTerminalId.has(item.id)) {
      const cliState = state.cliSessionsByProject[item.projectId];
      if (cliState?.loaded) {
        draftBaselineSessionIdsByTerminalId.set(
          item.id,
          new Set(
            cliState.items
              .filter((session) => session.provider === item.preset)
              .map((session) => session.id),
          ),
        );
      }
    }
    if (item.preset !== 'shell' && !manuallyRenamedTerminalIds.has(item.id) && !lastAutoTitleByTerminalId.has(item.id)) {
      if (isFallbackCliSessionTitle(item.title)) {
        lastAutoTitleByTerminalId.set(item.id, item.title);
      }
    }
  }
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
  if (terminal.preset !== 'shell' && !terminal.cliSessionId) {
    const cliState = state.cliSessionsByProject[terminal.projectId];
    if (cliState?.loaded) {
      draftBaselineSessionIdsByTerminalId.set(
        terminal.id,
        new Set(
          cliState.items
            .filter((session) => session.provider === terminal.preset)
            .map((session) => session.id),
        ),
      );
    }
  } else {
    draftBaselineSessionIdsByTerminalId.delete(terminal.id);
  }
  if (terminal.preset !== 'shell' && !manuallyRenamedTerminalIds.has(terminal.id)) {
    lastAutoTitleByTerminalId.set(terminal.id, terminal.title);
  }
  const nextTerminals = sortWorkTerminalsByOrder(
    [
      ...state.terminals.filter((item) => item.id !== terminal.id),
      terminal,
    ],
    state.terminalOrder,
  );
  let nextTerminalOrder = state.terminalOrder;
  if (state.terminalOrder.length > 0 && !state.terminalOrder.includes(terminal.id)) {
    nextTerminalOrder = nextTerminals.map((item) => item.id);
    persistStoredJson(TERMINAL_ORDER_KEY, nextTerminalOrder);
  }
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
    terminalOrder: nextTerminalOrder,
    activeTerminalId: terminal.id,
    activeProjectId: terminal.projectId,
    fileTabsByProject: deactivateWorkFile(terminal.projectId),
    gitTabsByProject: deactivateWorkGit(terminal.projectId),
    activeTerminalByProject: nextMap,
    unreadCompletedCliKeys: nextUnread,
  });
}

export function replaceWorkTerminalSession(updated: WorkTerminalSession): void {
  const exists = state.terminals.some((item) => item.id === updated.id);
  const nextTerminals = sortWorkTerminalsByOrder(
    exists
      ? state.terminals.map((item) => (item.id === updated.id ? updated : item))
      : [...state.terminals, updated],
    state.terminalOrder,
  );
  emit({
    ...state,
    terminals: nextTerminals,
  });
}

export function updateWorkTerminalMeta(
  terminalId: string,
  patch: WorkTerminalPatchInput,
  options?: { manualRename?: boolean },
): void {
  if (options?.manualRename && patch.title !== undefined) {
    manuallyRenamedTerminalIds.add(terminalId);
    lastAutoTitleByTerminalId.delete(terminalId);
  }
  let changed = false;
  let pinnedChanged = false;
  const updated = state.terminals.map((item) => {
    if (item.id !== terminalId) return item;
    let nextTitle = item.title;
    if (patch.title !== undefined) {
      const normalized = normalizeWorkTerminalTitle(patch.title);
      nextTitle = normalized;
    }
    const nextPinned = patch.pinned !== undefined ? Boolean(patch.pinned) : Boolean(item.pinned);
    const nextCliSessionId = patch.cliSessionId !== undefined ? patch.cliSessionId : item.cliSessionId;
    const nextCommand = (
      patch.cliSessionId !== undefined
      && item.preset !== 'shell'
    )
      ? buildCliResumeCommand(item.preset, patch.cliSessionId)
      : item.command;
    if (
      nextTitle !== item.title
      || nextPinned !== Boolean(item.pinned)
      || nextCliSessionId !== item.cliSessionId
      || nextCommand !== item.command
    ) {
      changed = true;
      if (nextPinned !== Boolean(item.pinned)) pinnedChanged = true;
      return {
        ...item,
        title: nextTitle,
        pinned: nextPinned,
        ...(nextCliSessionId !== undefined ? { cliSessionId: nextCliSessionId } : {}),
        command: nextCommand,
      };
    }
    return item;
  });
  if (!changed) return;
  const nextTerminals = sortWorkTerminalsByOrder(updated, state.terminalOrder);
  let nextTerminalOrder = state.terminalOrder;
  if (pinnedChanged) {
    nextTerminalOrder = nextTerminals.map((item) => item.id);
    persistStoredJson(TERMINAL_ORDER_KEY, nextTerminalOrder);
  }
  emit({
    ...state,
    terminalOrder: nextTerminalOrder,
    terminals: nextTerminals,
  });
}

export type WorkFileDraft = { text: string; base: HostFilePreview; saving?: boolean; composing?: boolean; error?: string };

export function isFileDraftDirty(draft: WorkFileDraft | undefined): boolean {
  return Boolean(draft && draft.text !== draft.base.text.replace(/\r\n?/gu, '\n'));
}

export function setWorkFileDraft(
  projectId: string,
  path: string,
  draft?: WorkFileDraft,
  expected?: WorkFileDraft,
): void {
  const tabs = state.fileTabsByProject[projectId];
  if (!tabs?.entries.some((entry) => entry.path === path)) return;
  if (expected && tabs.drafts.get(path) !== expected) return;
  const drafts = new Map(tabs.drafts);
  if (draft) drafts.set(path, draft);
  else drafts.delete(path);
  emit({ ...state, fileTabsByProject: { ...state.fileTabsByProject, [projectId]: { ...tabs, drafts } } });
}

function deactivateWorkFile(projectId: string): WorkStoreSnapshot['fileTabsByProject'] {
  const tabs = state.fileTabsByProject[projectId];
  if (!tabs?.activePath) return state.fileTabsByProject;
  return { ...state.fileTabsByProject, [projectId]: { ...tabs, activePath: null } };
}

function deactivateWorkGit(projectId: string): WorkStoreSnapshot['gitTabsByProject'] {
  if (state.gitTabsByProject[projectId] !== 'active') return state.gitTabsByProject;
  return { ...state.gitTabsByProject, [projectId]: 'inactive' };
}

export function openWorkGit(projectId: string): void {
  if (state.gitTabsByProject[projectId] === 'active') return;
  emit({ ...state, gitTabsByProject: { ...state.gitTabsByProject, [projectId]: 'active' } });
}

export function closeWorkGit(projectId: string): void {
  if (!state.gitTabsByProject[projectId]) return;
  const gitTabsByProject = { ...state.gitTabsByProject };
  delete gitTabsByProject[projectId];
  emit({ ...state, gitTabsByProject });
}

export function openWorkFile(projectId: string, entry: WorkFileTab): void {
  const entries = state.fileTabsByProject[projectId]?.entries ?? [];
  const path = workFileTabPath(entry);
  emit({
    ...state,
    gitTabsByProject: deactivateWorkGit(projectId),
    fileTabsByProject: {
      ...state.fileTabsByProject,
      [projectId]: {
        entries: entries.some((file) => workFileTabPath(file) === path) ? entries : [...entries, entry],
        activePath: path,
        drafts: state.fileTabsByProject[projectId]?.drafts ?? new Map(),
      },
    },
  });
}

export function closeWorkFiles(projectId: string, paths: readonly string[]): void {
  const tabs = state.fileTabsByProject[projectId];
  if (!tabs || !paths.length) return;
  const entries = tabs.entries.filter((file) => !paths.includes(workFileTabPath(file)));
  const activePath = tabs.activePath && paths.includes(tabs.activePath)
    ? (entries.length ? workFileTabPath(entries[entries.length - 1]) : null)
    : tabs.activePath;
  const drafts = new Map(tabs.drafts);
  paths.forEach((path) => { drafts.delete(path); });
  emit({
    ...state,
    fileTabsByProject: { ...state.fileTabsByProject, [projectId]: { entries, activePath, drafts } },
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
    fileTabsByProject: deactivateWorkFile(target.projectId),
    gitTabsByProject: deactivateWorkGit(target.projectId),
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
  pruneTerminalTracking(nextTerminals);
  const nextTerminalOrder = state.terminalOrder.filter((id) => !targets.has(id));
  if (nextTerminalOrder.length !== state.terminalOrder.length) {
    persistStoredJson(TERMINAL_ORDER_KEY, nextTerminalOrder);
  }
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

  const nextActiveTerminal = nextActive
    ? nextTerminals.find((item) => item.id === nextActive) ?? null
    : null;
  let unreadChanged = false;
  let nextUnread = state.unreadCompletedCliKeys;
  if (nextActiveTerminal && nextActiveTerminal.preset !== 'shell' && nextActiveTerminal.cliSessionId) {
    const key = workCliSessionKey(
      nextActiveTerminal.projectId,
      nextActiveTerminal.preset,
      nextActiveTerminal.cliSessionId,
    );
    if (nextUnread[key]) {
      nextUnread = { ...nextUnread };
      delete nextUnread[key];
      unreadChanged = true;
    }
  }

  emit({
    ...state,
    terminals: nextTerminals,
    terminalOrder: nextTerminalOrder,
    activeTerminalId: nextActive,
    activeTerminalByProject: nextMap,
    ...(unreadChanged ? { unreadCompletedCliKeys: nextUnread } : {}),
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

export function setWorkEditorSettings(settings: { editorFontSize: number; editorAutoSave: boolean; editorDiffLayout?: WorkEditorDiffLayout }): void {
  emit({
    ...state,
    editorFontSize: normalizeWorkEditorFontSize(settings.editorFontSize),
    editorAutoSave: settings.editorAutoSave,
    editorDiffLayout: normalizeWorkEditorDiffLayout(settings.editorDiffLayout ?? state.editorDiffLayout),
  });
}

export function hydrateWorkSettings(settings: {
  defaultWindowsShell: WindowsTerminalShell;
  activeProjectId: string | null;
  activeTerminals: Record<string, string | null>;
  filesPanelOpen?: boolean;
  filesPanelWidth?: number | null;
  persistTerminalScrollback?: boolean;
  editorFontSize?: number;
  editorAutoSave?: boolean;
  editorDiffLayout?: WorkEditorDiffLayout;
  projectOrder?: string[];
  cliProviderOrder?: WorkCliProvider[];
  terminalOrder?: string[];
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
  const nextTerminalOrder = settings.terminalOrder !== undefined
    ? normalizeWorkTerminalOrder(settings.terminalOrder)
    : state.terminalOrder;
  if (settings.projectOrder !== undefined) persistStoredJson(PROJECT_ORDER_KEY, nextProjectOrder);
  if (settings.cliProviderOrder !== undefined) persistStoredJson(CLI_PROVIDER_ORDER_KEY, nextCliProviderOrder);
  if (settings.terminalOrder !== undefined) persistStoredJson(TERMINAL_ORDER_KEY, nextTerminalOrder);

  const orderedProjects = sortWorkProjectsByOrder(state.projects, nextProjectOrder);
  const orderedTerminals = sortWorkTerminalsByOrder(state.terminals, nextTerminalOrder);
  lastHydratedActiveProjectId = settings.activeProjectId ?? null;

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
    orderedTerminals,
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
    terminals: orderedTerminals,
    projectOrder: nextProjectOrder,
    cliProviderOrder: nextCliProviderOrder,
    terminalOrder: nextTerminalOrder,
    defaultWindowsShell: normalizedShell,
    defaultWindowsShellLoaded: true,
    persistTerminalScrollback: Boolean(settings.persistTerminalScrollback),
    editorFontSize: normalizeWorkEditorFontSize(settings.editorFontSize ?? state.editorFontSize),
    editorAutoSave: settings.editorAutoSave ?? state.editorAutoSave,
    editorDiffLayout: normalizeWorkEditorDiffLayout(settings.editorDiffLayout ?? state.editorDiffLayout),
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

export type CliTerminalSyncPatch = {
  terminalId: string;
  patch: WorkTerminalPatchInput;
};

const DRAFT_SESSION_CLOCK_SKEW_MS = 5_000;

export function setWorkProjectCliSessions(
  projectId: string,
  payload: WorkProjectCliSessionsResponse,
  requestedLimit = CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
): CliTerminalSyncPatch[] {
  const prev = state.cliSessionsByProject[projectId];
  const prevByKey = new Map<string, WorkCliSession>();
  for (const item of prev?.items ?? []) {
    prevByKey.set(workCliSessionKey(projectId, item.provider, item.id), item);
  }

  // 1. Bind any open unbound "新对话" terminal to newly created on-disk CLI sessions
  //    and keep open CLI terminal titles synced with real-time session titles.
  const boundSessionKeys = new Set<string>();
  for (const item of state.terminals) {
    if (item.projectId === projectId && item.preset !== 'shell' && item.cliSessionId) {
      boundSessionKeys.add(`${item.preset}:${item.cliSessionId}`);
    }
  }
  const unboundDrafts = state.terminals
    .filter((item) => item.projectId === projectId && item.preset !== 'shell' && !item.cliSessionId)
    .sort((left, right) => left.createdAt - right.createdAt);

  const pendingBind = new Map<string, WorkCliSession>();
  for (const draft of unboundDrafts) {
    let baseline = draftBaselineSessionIdsByTerminalId.get(draft.id);
    if (!baseline) {
      baseline = new Set(
        payload.items
          .filter((item) => item.provider === draft.preset && item.updatedAt < draft.createdAt - DRAFT_SESSION_CLOCK_SKEW_MS)
          .map((item) => item.id),
      );
      draftBaselineSessionIdsByTerminalId.set(draft.id, baseline);
    }
    const candidates = payload.items
      .filter((item) => (
        item.provider === draft.preset
        && !boundSessionKeys.has(`${item.provider}:${item.id}`)
        && !baseline.has(item.id)
        && item.updatedAt >= draft.createdAt - DRAFT_SESSION_CLOCK_SKEW_MS
      ))
      .sort((left, right) => {
        const leftRunning = left.status === 'running' ? 0 : 1;
        const rightRunning = right.status === 'running' ? 0 : 1;
        if (leftRunning !== rightRunning) return leftRunning - rightRunning;
        return left.updatedAt - right.updatedAt;
      });
    const matched = candidates[0];
    if (matched) {
      boundSessionKeys.add(`${matched.provider}:${matched.id}`);
      pendingBind.set(draft.id, matched);
      draftBaselineSessionIdsByTerminalId.delete(draft.id);
    }
  }

  const sessionByProviderId = new Map<string, WorkCliSession>();
  for (const item of payload.items) {
    sessionByProviderId.set(`${item.provider}:${item.id}`, item);
  }

  let terminalsChanged = false;
  const serverPatches: CliTerminalSyncPatch[] = [];
  const nextTerminals = state.terminals.map((term) => {
    if (term.projectId !== projectId || term.preset === 'shell') return term;
    const newlyMatched = pendingBind.get(term.id);
    const effectiveCliSessionId = newlyMatched?.id ?? term.cliSessionId;
    if (!effectiveCliSessionId) return term;

    const matchedSession = newlyMatched ?? sessionByProviderId.get(`${term.preset}:${effectiveCliSessionId}`);
    let nextTitle = term.title;
    let titleUpdated = false;

    if (matchedSession && !manuallyRenamedTerminalIds.has(term.id)) {
      const formatted = formatCliTerminalTitle(matchedSession.title, matchedSession.provider);
      const prevSession = prevByKey.get(workCliSessionKey(projectId, matchedSession.provider, matchedSession.id));
      const prevFormatted = prevSession ? formatCliTerminalTitle(prevSession.title, prevSession.provider) : null;
      const recordedAutoTitle = lastAutoTitleByTerminalId.get(term.id);
      const isFallbackCurrent = isFallbackCliSessionTitle(term.title);

      if (!isFallbackCliSessionTitle(matchedSession.title)) {
        const canAutoUpdate = (
          recordedAutoTitle === term.title
          || isFallbackCurrent
          || prevFormatted === term.title
          || (recordedAutoTitle === undefined && !prevSession && term.title === formatted)
        );
        if (canAutoUpdate) {
          lastAutoTitleByTerminalId.set(term.id, formatted);
          if (formatted !== term.title) {
            nextTitle = formatted;
            titleUpdated = true;
          }
        }
      } else if (recordedAutoTitle === undefined && (isFallbackCurrent || prevFormatted === term.title)) {
        lastAutoTitleByTerminalId.set(term.id, term.title);
      }
    }

    if (!newlyMatched && !titleUpdated) return term;

    terminalsChanged = true;
    const patch: WorkTerminalPatchInput = {
      ...(newlyMatched ? { cliSessionId: newlyMatched.id } : {}),
      ...(titleUpdated ? { title: nextTitle } : {}),
    };
    serverPatches.push({ terminalId: term.id, patch });

    return {
      ...term,
      title: nextTitle,
      ...(newlyMatched
        ? {
            cliSessionId: newlyMatched.id,
            command: buildCliResumeCommand(newlyMatched.provider, newlyMatched.id),
          }
        : {}),
    };
  });

  const activeTerm = state.activeTerminalId
    ? nextTerminals.find((item) => item.id === state.activeTerminalId) ?? null
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
    ...(terminalsChanged ? { terminals: nextTerminals } : {}),
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

  return serverPatches;
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
  lastHydratedActiveProjectId = null;
  hasExplicitFilesPanelOpen = false;
  hasExplicitFilesPanelWidth = false;
  draftBaselineSessionIdsByTerminalId = new Map();
  lastAutoTitleByTerminalId = new Map();
  manuallyRenamedTerminalIds = new Set();
  try {
    globalThis.sessionStorage?.removeItem(ACTIVE_PROJECT_KEY);
    globalThis.localStorage?.removeItem(ACTIVE_TERMINALS_KEY);
    globalThis.localStorage?.removeItem(EXPANDED_PROJECTS_KEY);
    globalThis.localStorage?.removeItem(PROJECT_ORDER_KEY);
    globalThis.localStorage?.removeItem(CLI_PROVIDER_ORDER_KEY);
    globalThis.localStorage?.removeItem(TERMINAL_ORDER_KEY);
    globalThis.localStorage?.removeItem(COLLAPSED_CLI_GROUPS_KEY);
    globalThis.localStorage?.removeItem(PROJECT_AI_EXPANDED_GROUPS_KEY);
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
    terminalOrder: [],
    expandedProjectIds: {},
    collapsedCliGroups: {},
    projectAiExpandedGroups: defaultProjectAiExpandedGroups(),
    cliVisibleCounts: {},
    cliSessionsByProject: {},
    unreadCompletedCliKeys: {},
    cliRefreshTick: 0,
    hosts: [],
    terminals: [],
    gitTabsByProject: {},
    fileTabsByProject: {},
    activeTerminalId: null,
    activeTerminalByProject: {},
    filesPanelOpen: true,
    filesPanelWidth: null,
    fileSearchProjectId: null,
    serverPlatform: null,
    windowsBuild: null,
    defaultWindowsShell: DEFAULT_WINDOWS_SHELL,
    defaultWindowsShellLoaded: false,
    persistTerminalScrollback: false,
    editorFontSize: DEFAULT_WORK_EDITOR_FONT_SIZE,
    editorAutoSave: false,
    editorDiffLayout: 'inline',
    hostUnlockVersion: 0,
  });
}
