import {
  CLI_SESSIONS_DEFAULT_FETCH_LIMIT,
  CLI_SESSIONS_INITIAL_VISIBLE,
  CLI_SESSIONS_PAGE_STEP,
  NEW_CLI_SESSION_TITLE,
  WORK_CLI_PROVIDER_LABELS,
  buildCliResumeCommand,
  formatCliTerminalTitle,
  isFallbackCliSessionTitle,
  normalizeWorkCliProviderOrder,
  workCliGroupKey,
  type WorkCliProvider,
  type WorkCliSession,
} from '@contract/work-cli';
import { LOCAL_WORK_HOST_ID, resolveWorkTerminalCommand, type WorkProject } from '@contract/work-projects';
import type { WorkHost } from '@contract/work-hosts';
import {
  defaultTerminalCommand,
  type WorkTerminalSession,
} from '@contract/work-terminals';
import { ChevronRight, FolderPlus, Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { SidebarMenu } from '@/components/web/sidebar-menu';
import { listWorkHosts } from '@/features/hosts/hosts-api';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { CreateProjectDialog } from './create-project-dialog';
import { TerminalPresetIcon } from './terminal-preset-icon';
import {
  createPreviewCliSessions,
  createPreviewWorkHosts,
  createWorkTerminal,
  deleteWorkProject,
  listProjectCliSessions,
  listWorkProjects,
  listWorkTerminals,
  updateWorkTerminal,
} from './work-api';
import { WorkErrorDialog } from './work-error-dialog';
import { loadWorkSettings, saveWorkSettings } from './work-shell-preference';
import {
  addWorkTerminal,
  bumpCliSessionsRefresh,
  collapseWorkCliSessions,
  detectPreviewPlatform,
  getWorkState,
  hydrateWorkSettings,
  markWorkCliSessionRead,
  removeWorkProject,
  reorderWorkCliProviders,
  reorderWorkProjects,
  selectWorkTerminal,
  setWorkHosts,
  setWorkCliGroupCollapsed,
  setWorkProjectCliSessions,
  setWorkProjectCliSessionsError,
  setWorkProjectCliSessionsLoading,
  setWorkProjectExpanded,
  setWorkProjects,
  setWorkProjectsError,
  setWorkServerPlatform,
  setWorkTerminals,
  showMoreWorkCliSessions,
  toggleWorkCliGroupCollapsed,
  toggleWorkProjectExpanded,
  upsertWorkProject,
  useWorkState,
  workCliSessionKey,
  writeActiveProjectId,
} from './work-state';

const CLI_POLL_FAST_INTERVAL_MS = 1_500;
const CLI_POLL_INTERVAL_MS = 3_500;
const CLI_FETCH_PAGE_STEP = 60;

function resolveDragPosition(
  event: DragEvent<HTMLElement>,
  fromIndex: number,
  toIndex: number,
): 'before' | 'after' {
  const rect = typeof event.currentTarget?.getBoundingClientRect === 'function'
    ? event.currentTarget.getBoundingClientRect()
    : null;
  if (rect && rect.height > 0 && event.clientY > 0) {
    return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
  }
  return fromIndex < toIndex ? 'after' : 'before';
}

function hostDisplayName(hostId: string, hostMap: Map<string, WorkHost>): string {
  if (hostId === LOCAL_WORK_HOST_ID) return '本机';
  const host = hostMap.get(hostId);
  if (!host) return '已移除主机';
  return host.name;
}

function createPreviewResumedTerminal(project: WorkProject, session: WorkCliSession): WorkTerminalSession {
  return {
    id: `mock-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    projectId: project.id,
    hostId: project.hostId,
    title: formatCliTerminalTitle(session.title, session.provider),
    preset: session.provider,
    cliSessionId: session.id,
    command: resolveWorkTerminalCommand(project, session.provider, buildCliResumeCommand(session.provider, session.id)),
    cwd: project.directory,
    status: 'running',
    exitCode: null,
    pinned: false,
    createdAt: Date.now(),
  };
}

function createPreviewNewCliTerminal(project: WorkProject, provider: WorkCliProvider): WorkTerminalSession {
  return {
    id: `mock-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    projectId: project.id,
    hostId: project.hostId,
    title: NEW_CLI_SESSION_TITLE,
    preset: provider,
    command: resolveWorkTerminalCommand(project, provider, defaultTerminalCommand(provider)),
    cwd: project.directory,
    status: 'running',
    exitCode: null,
    pinned: false,
    createdAt: Date.now(),
  };
}

export function WorkSidebarPanel({ collapsed = false }: { collapsed?: boolean }) {
  const instance = useInstance();
  const preview = useIsPreview();
  const {
    activeProjectId,
    activeTerminalId,
    activeTerminalByProject,
    filesPanelOpen,
    filesPanelWidth,
    projectOrder,
    cliProviderOrder,
    terminalOrder,
    projects,
    projectsLoaded,
    projectsError,
    expandedProjectIds,
    collapsedCliGroups,
    cliVisibleCounts,
    cliSessionsByProject,
    unreadCompletedCliKeys,
    cliRefreshTick,
    hosts,
    terminals,
    serverPlatform,
    defaultWindowsShellLoaded,
    hostUnlockVersion,
  } = useWorkState();

  const [groupCollapsed, setGroupCollapsed] = useState(false);
  const [dialogProject, setDialogProject] = useState<WorkProject | 'create' | null>(null);
  const [deleting, setDeleting] = useState<WorkProject | null>(null);
  const [menu, setMenu] = useState<{
    projectId: string;
    anchor: HTMLElement;
    focusTarget: HTMLElement | null;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openingCliKey, setOpeningCliKey] = useState<string | null>(null);
  const [cliNotice, setCliNotice] = useState<string | null>(null);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{
    projectId: string;
    position: 'before' | 'after';
  } | null>(null);
  const [draggingCliGroup, setDraggingCliGroup] = useState<{
    projectId: string;
    provider: WorkCliProvider;
  } | null>(null);
  const [cliGroupDropTarget, setCliGroupDropTarget] = useState<{
    projectId: string;
    provider: WorkCliProvider;
    position: 'before' | 'after';
  } | null>(null);
  const dragProjectIdRef = useRef<string | null>(null);
  const dragCliGroupRef = useRef<{ projectId: string; provider: WorkCliProvider } | null>(null);
  const pendingNewCliKeysRef = useRef(new Set<string>());
  const lastSavedSelectionRef = useRef<string | null>(null);

  const canUseServer = !preview && instance.status === 'ready';

  useEffect(() => {
    if (preview) {
      if (hosts.length === 0) setWorkHosts(createPreviewWorkHosts());
      if (serverPlatform === null) setWorkServerPlatform(detectPreviewPlatform());
      return;
    }
    if (!canUseServer || projectsLoaded) return;
    let cancelled = false;
    Promise.all([
      listWorkProjects(instance.request),
      listWorkHosts(instance.request).catch(() => ({ items: [] as WorkHost[] })),
      listWorkTerminals(instance.request).catch(() => ({ items: [] as WorkTerminalSession[], platform: undefined })),
      loadWorkSettings(instance.request).catch(() => null),
    ])
      .then(([projectRes, hostRes, terminalRes, workSettings]) => {
        if (cancelled) return;
        if (terminalRes.platform) setWorkServerPlatform(terminalRes.platform, terminalRes.windowsBuild ?? null);
        if (workSettings) {
          lastSavedSelectionRef.current = JSON.stringify({
            activeProjectId: workSettings.activeProjectId,
            activeTerminals: workSettings.activeTerminals,
            filesPanelOpen: workSettings.filesPanelOpen,
            filesPanelWidth: workSettings.filesPanelWidth,
            projectOrder: workSettings.projectOrder,
            cliProviderOrder: workSettings.cliProviderOrder,
            terminalOrder: workSettings.terminalOrder,
          });
          hydrateWorkSettings(workSettings);
        }
        setWorkProjects(projectRes.items);
        setWorkHosts(hostRes.items);
        setWorkTerminals(terminalRes.items);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setWorkProjectsError(reason instanceof Error && reason.message ? reason.message : '读取项目列表失败。');
      });
    return () => { cancelled = true; };
  }, [canUseServer, hosts.length, instance.request, preview, projectsLoaded, serverPlatform]);

  useEffect(() => {
    if (!canUseServer || !projectsLoaded || !defaultWindowsShellLoaded) return;
    const serialized = JSON.stringify({
      activeProjectId,
      activeTerminals: activeTerminalByProject,
      filesPanelOpen,
      filesPanelWidth,
      projectOrder,
      cliProviderOrder,
      terminalOrder,
    });
    if (serialized === lastSavedSelectionRef.current) return;
    const timer = setTimeout(() => {
      lastSavedSelectionRef.current = serialized;
      void saveWorkSettings(instance.request, {
        activeProjectId,
        activeTerminals: activeTerminalByProject,
        filesPanelOpen,
        filesPanelWidth,
        projectOrder,
        cliProviderOrder,
        terminalOrder,
      }).catch(() => {});
    }, 100);
    return () => clearTimeout(timer);
  }, [
    activeProjectId,
    activeTerminalByProject,
    canUseServer,
    cliProviderOrder,
    defaultWindowsShellLoaded,
    filesPanelOpen,
    filesPanelWidth,
    instance.request,
    projectOrder,
    projectsLoaded,
    terminalOrder,
  ]);

  const expandedList = useMemo(
    () => projects.filter((project) => expandedProjectIds[project.id]).map((project) => project.id),
    [expandedProjectIds, projects],
  );
  const expandedKey = expandedList.join(',');

  const fetchProjectCliSessions = useCallback(async (
    projectId: string,
    limit: number,
    options: { silent?: boolean; loadingMore?: boolean } = {},
  ) => {
    if (preview) {
      setWorkProjectCliSessions(projectId, createPreviewCliSessions(projectId), limit);
      return;
    }
    if (!canUseServer) return;
    if (!options.silent) {
      setWorkProjectCliSessionsLoading(projectId, {
        loadingMore: options.loadingMore,
        requestedLimit: limit,
      });
    }
    try {
      const result = await listProjectCliSessions(instance.request, projectId, limit);
      const patches = setWorkProjectCliSessions(projectId, result, limit);
      for (const item of patches) {
        void updateWorkTerminal(instance.request, item.terminalId, item.patch).catch(() => {});
      }
    } catch (reason) {
      if (!options.silent || !getWorkState().cliSessionsByProject[projectId]?.loaded) {
        setWorkProjectCliSessionsError(
          projectId,
          reason instanceof Error && reason.message ? reason.message : '读取 CLI 对话失败。',
        );
      }
    }
  }, [canUseServer, instance.request, preview]);

  // Load expanded projects on expand, refresh tick, or host unlock.
  useEffect(() => {
    if (collapsed || !expandedKey) return;
    const ids = expandedKey.split(',').filter(Boolean);
    const currentSessions = getWorkState().cliSessionsByProject;
    for (const projectId of ids) {
      const current = currentSessions[projectId];
      if (preview) {
        if (!current?.loaded) {
          setWorkProjectCliSessions(projectId, createPreviewCliSessions(projectId), CLI_SESSIONS_DEFAULT_FETCH_LIMIT);
        }
        continue;
      }
      if (!canUseServer) continue;
      const limit = current?.requestedLimit ?? CLI_SESSIONS_DEFAULT_FETCH_LIMIT;
      void fetchProjectCliSessions(projectId, limit, { silent: Boolean(current?.loaded) });
    }
  }, [
    canUseServer,
    cliRefreshTick,
    collapsed,
    expandedKey,
    fetchProjectCliSessions,
    hostUnlockVersion,
    preview,
  ]);

  // Periodically poll expanded projects while visible so running/completed state and titles stay live.
  useEffect(() => {
    if (collapsed || preview || !canUseServer || !expandedKey) return;
    const ids = expandedKey.split(',').filter(Boolean);
    if (ids.length === 0) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const hasFastCliPoll = () => {
      const currentState = getWorkState();
      for (const projectId of ids) {
        if (currentState.terminals.some((item) => (
          item.projectId === projectId
          && item.preset !== 'shell'
          && (!item.cliSessionId || item.status === 'running')
        ))) {
          return true;
        }
        if ((currentState.cliSessionsByProject[projectId]?.items ?? []).some((item) => item.status === 'running')) {
          return true;
        }
      }
      return false;
    };

    const refreshAll = (silent: boolean) => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const currentSessions = getWorkState().cliSessionsByProject;
      for (const projectId of ids) {
        const current = currentSessions[projectId];
        const limit = current?.requestedLimit ?? CLI_SESSIONS_DEFAULT_FETCH_LIMIT;
        void fetchProjectCliSessions(projectId, limit, { silent });
      }
    };

    const scheduleNext = () => {
      if (disposed) return;
      const delay = hasFastCliPoll() ? CLI_POLL_FAST_INTERVAL_MS : CLI_POLL_INTERVAL_MS;
      timer = setTimeout(() => {
        refreshAll(true);
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    const onVisibility = () => {
      if (!document.hidden) refreshAll(true);
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [canUseServer, collapsed, expandedKey, fetchProjectCliSessions, preview]);

  const hostMap = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const normalizedProviderOrder = useMemo(
    () => normalizeWorkCliProviderOrder(cliProviderOrder),
    [cliProviderOrder],
  );
  const clearProjectDragState = useCallback(() => {
    dragProjectIdRef.current = null;
    setDraggingProjectId(null);
    setProjectDropTarget(null);
  }, []);
  const clearCliGroupDragState = useCallback(() => {
    dragCliGroupRef.current = null;
    setDraggingCliGroup(null);
    setCliGroupDropTarget(null);
  }, []);
  const syncHosts = useCallback((nextHosts: WorkHost[]) => {
    setWorkHosts(nextHosts);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuProject = menu ? projects.find((item) => item.id === menu.projectId) ?? null : null;
  const activeTerminal = activeTerminalId
    ? terminals.find((item) => item.id === activeTerminalId) ?? null
    : null;

  async function handleOpenCliSession(project: WorkProject, session: WorkCliSession) {
    const key = workCliSessionKey(project.id, session.provider, session.id);
    if (openingCliKey === key) return;
    markWorkCliSessionRead(project.id, session.provider, session.id);

    const existing = terminals.find((item) => (
      item.projectId === project.id
      && item.preset === session.provider
      && item.cliSessionId === session.id
      && (item.status === 'running' || item.status === 'restored')
    )) ?? terminals.find((item) => (
      item.projectId === project.id
      && item.preset === session.provider
      && item.cliSessionId === session.id
    ));
    if (existing) {
      selectWorkTerminal(existing.id);
      return;
    }

    writeActiveProjectId(project.id);
    if (preview) {
      addWorkTerminal(createPreviewResumedTerminal(project, session));
      return;
    }

    setOpeningCliKey(key);
    try {
      const created = await createWorkTerminal(instance.request, {
        projectId: project.id,
        preset: session.provider,
        cliSessionId: session.id,
        title: formatCliTerminalTitle(session.title, session.provider),
        command: buildCliResumeCommand(session.provider, session.id),
      });
      addWorkTerminal(created);
    } catch (reason) {
      setCliNotice(reason instanceof Error && reason.message ? reason.message : '打开 CLI 对话失败，请重试。');
    } finally {
      setOpeningCliKey((current) => (current === key ? null : current));
    }
  }

  async function handleCreateNewCliSession(project: WorkProject, provider: WorkCliProvider) {
    const newKey = workCliGroupKey(project.id, provider);
    if (pendingNewCliKeysRef.current.has(newKey)) return;

    setWorkProjectExpanded(project.id, true);
    setWorkCliGroupCollapsed(project.id, provider, false);

    const currentTerminals = getWorkState().terminals;
    const existing = currentTerminals.find((item) => (
      item.projectId === project.id
      && item.preset === provider
      && !item.cliSessionId
    ));
    if (existing) {
      writeActiveProjectId(project.id);
      selectWorkTerminal(existing.id);
      return;
    }

    writeActiveProjectId(project.id);
    if (preview) {
      addWorkTerminal(createPreviewNewCliTerminal(project, provider));
      bumpCliSessionsRefresh();
      return;
    }

    pendingNewCliKeysRef.current.add(newKey);
    setOpeningCliKey(newKey);
    try {
      const created = await createWorkTerminal(instance.request, {
        projectId: project.id,
        preset: provider,
        title: NEW_CLI_SESSION_TITLE,
      });
      addWorkTerminal(created);
      bumpCliSessionsRefresh();
    } catch (reason) {
      setCliNotice(reason instanceof Error && reason.message ? reason.message : '启动 CLI 对话失败，请重试。');
    } finally {
      pendingNewCliKeysRef.current.delete(newKey);
      setOpeningCliKey((current) => (current === newKey ? null : current));
    }
  }

  async function handleShowMore(projectId: string, provider: WorkCliProvider) {
    const current = cliSessionsByProject[projectId];
    const nextVisible = showMoreWorkCliSessions(projectId, provider, CLI_SESSIONS_PAGE_STEP);
    const providerCount = current
      ? current.items.filter((item) => item.provider === provider).length
      : 0;
    if (!preview && canUseServer && current && nextVisible > providerCount && current.hasMore && !current.loadingMore) {
      const nextLimit = Math.min(200, current.requestedLimit + CLI_FETCH_PAGE_STEP);
      await fetchProjectCliSessions(projectId, nextLimit, { loadingMore: true });
    }
  }

  async function confirmRemove() {
    if (!deleting || busyId) return;
    const target = deleting;
    setWorkProjectsError(null);
    if (preview) {
      removeWorkProject(target.id);
      setDeleting(null);
      return;
    }
    setBusyId(target.id);
    try {
      await deleteWorkProject(instance.request, target.id, target.revision);
      removeWorkProject(target.id);
      setDeleting(null);
    } catch (reason) {
      setWorkProjectsError(reason instanceof Error && reason.message ? reason.message : '移除项目失败。');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      {collapsed ? (
        <button
          type="button"
          className="sidebar-rail-btn"
          aria-label="创建项目"
          onClick={() => {
            setWorkProjectsError(null);
            setDialogProject('create');
          }}
        >
          <FolderPlus size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      ) : (
        <>
          <nav className="sidebar-primary" aria-label="工作操作">
            <button
              type="button"
              className="new-conversation"
              onClick={() => {
                setWorkProjectsError(null);
                setDialogProject('create');
              }}
            >
              <FolderPlus size={19} strokeWidth={1.75} aria-hidden="true" />
              <span>创建项目</span>
            </button>
          </nav>

          <nav className="conversation-list" aria-label="项目列表">
            <section className="conversation-group">
              <h2 className="sidebar-section-label">
                <button
                  type="button"
                  aria-expanded={!groupCollapsed}
                  aria-controls="sidebar-work-projects"
                  onClick={() => setGroupCollapsed((current) => !current)}
                >
                  <span>项目</span>
                  <Icon name="chevron" size={16} />
                </button>
              </h2>
              <div id="sidebar-work-projects" hidden={groupCollapsed}>
                {projectsError && <p className="work-sidebar-error" role="alert">{projectsError}</p>}
                {!projectsLoaded && canUseServer ? (
                  <p className="work-sidebar-loading" role="status">正在读取项目…</p>
                ) : projects.length > 0 ? (
                  projects.map((project, projectIndex) => {
                    const isActive = activeProjectId === project.id;
                    const isExpanded = Boolean(expandedProjectIds[project.id]);
                    const hostLabel = hostDisplayName(project.hostId, hostMap);
                    const childrenId = `work-project-children-${project.id}`;
                    const cliState = cliSessionsByProject[project.id];
                    const sessionsByProvider = new Map<WorkCliProvider, WorkCliSession[]>();
                    for (const session of cliState?.items ?? []) {
                      const bucket = sessionsByProvider.get(session.provider);
                      if (bucket) bucket.push(session);
                      else sessionsByProvider.set(session.provider, [session]);
                    }
                    const draftTerminalByProvider = new Map<WorkCliProvider, WorkTerminalSession>();
                    for (const term of terminals) {
                      if (term.projectId === project.id && term.preset !== 'shell' && !term.cliSessionId) {
                        if (!draftTerminalByProvider.has(term.preset)) {
                          draftTerminalByProvider.set(term.preset, term);
                        }
                      }
                    }
                    const cliGroups = normalizedProviderOrder.map((provider) => ({
                      provider,
                      sessions: sessionsByProvider.get(provider) ?? [],
                      draftTerminal: draftTerminalByProvider.get(provider) ?? null,
                    }));
                    const showChildren = isExpanded;
                    const isDraggingProject = draggingProjectId === project.id;
                    const projectDropPos = projectDropTarget?.projectId === project.id
                      ? projectDropTarget.position
                      : null;

                    const openProjectMenu = (
                      rowEl: HTMLElement,
                      focusTarget: HTMLElement | null,
                    ) => {
                      if (busyId === project.id) return;
                      setMenu({
                        projectId: project.id,
                        anchor: rowEl,
                        focusTarget,
                      });
                    };

                    return (
                      <div key={project.id} className="work-project-group">
                        <div
                          className={`work-project-item${isActive ? ' is-active' : ''}${menuProject?.id === project.id ? ' menu-open' : ''}${isDraggingProject ? ' is-dragging' : ''}${projectDropPos === 'before' ? ' is-drop-before' : ''}${projectDropPos === 'after' ? ' is-drop-after' : ''}`}
                          data-project-id={project.id}
                          draggable={busyId !== project.id}
                          onDragStart={(event) => {
                            if (busyId === project.id) {
                              event.preventDefault();
                              return;
                            }
                            closeMenu();
                            clearCliGroupDragState();
                            dragProjectIdRef.current = project.id;
                            setDraggingProjectId(project.id);
                            if (event.dataTransfer) {
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData('application/x-matrius-project', project.id);
                            }
                          }}
                          onDragOver={(event) => {
                            const sourceId = dragProjectIdRef.current;
                            if (!sourceId || sourceId === project.id) return;
                            event.preventDefault();
                            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                            const fromIndex = projects.findIndex((item) => item.id === sourceId);
                            const position = resolveDragPosition(event, fromIndex, projectIndex);
                            setProjectDropTarget((prev) => (
                              prev?.projectId === project.id && prev.position === position
                                ? prev
                                : { projectId: project.id, position }
                            ));
                          }}
                          onDragLeave={(event) => {
                            const nextTarget = event.relatedTarget as Node | null;
                            if (nextTarget && event.currentTarget.contains(nextTarget)) return;
                            setProjectDropTarget((prev) => (
                              prev?.projectId === project.id ? null : prev
                            ));
                          }}
                          onDrop={(event) => {
                            const sourceId = dragProjectIdRef.current
                              ?? event.dataTransfer?.getData('application/x-matrius-project')
                              ?? '';
                            if (!sourceId || sourceId === project.id) {
                              clearProjectDragState();
                              return;
                            }
                            event.preventDefault();
                            const fromIndex = projects.findIndex((item) => item.id === sourceId);
                            const position = resolveDragPosition(event, fromIndex, projectIndex);
                            clearProjectDragState();
                            reorderWorkProjects(sourceId, project.id, position);
                          }}
                          onDragEnd={clearProjectDragState}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            const rowEl = event.currentTarget;
                            const focusTarget = rowEl.querySelector<HTMLElement>('.work-project-select');
                            openProjectMenu(rowEl, focusTarget);
                          }}
                        >
                          <button
                            type="button"
                            className="work-project-toggle"
                            aria-label={isExpanded ? `收起项目：${project.name}` : `展开项目：${project.name}`}
                            aria-expanded={isExpanded}
                            aria-controls={showChildren ? childrenId : undefined}
                            onClick={() => toggleWorkProjectExpanded(project.id)}
                          >
                            <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="work-project-select"
                            aria-current={isActive ? 'true' : undefined}
                            title={`${hostLabel} · ${project.directory}`}
                            onClick={() => writeActiveProjectId(project.id)}
                            onKeyDown={(event) => {
                              if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                                event.preventDefault();
                                const rowEl = event.currentTarget.closest<HTMLElement>('.work-project-item') ?? event.currentTarget;
                                openProjectMenu(rowEl, event.currentTarget);
                              }
                            }}
                          >
                            <span className="work-project-name">{project.name}</span>
                            {project.hostId !== LOCAL_WORK_HOST_ID && (
                              <span className="work-project-host">{hostLabel}</span>
                            )}
                          </button>
                        </div>

                        {showChildren && (
                          <div
                            id={childrenId}
                            className="work-project-children"
                            role="region"
                            aria-label={`${project.name} CLI 对话`}
                          >
                            {cliState?.error && (
                              <p className="work-cli-error" role="alert">{cliState.error}</p>
                            )}
                            {cliGroups.map((group, groupIndex) => {
                              const { provider, sessions: groupSessions, draftTerminal } = group;
                              const hasGroupItems = Boolean(draftTerminal) || groupSessions.length > 0;
                              const groupKey = workCliGroupKey(project.id, provider);
                              const isGroupCollapsed = Boolean(collapsedCliGroups[groupKey]);
                              const visibleLimit = cliVisibleCounts[groupKey] ?? CLI_SESSIONS_INITIAL_VISIBLE;
                              const visibleGroupSessions = groupSessions.slice(0, visibleLimit);
                              const hasMoreInGroup = Boolean(
                                groupSessions.length > visibleLimit || cliState?.hasMore,
                              );
                              const canCollapseGroupMore = Boolean(
                                visibleLimit > CLI_SESSIONS_INITIAL_VISIBLE
                                  && groupSessions.length > CLI_SESSIONS_INITIAL_VISIBLE,
                              );
                              const isDraggingGroup = draggingCliGroup?.projectId === project.id
                                && draggingCliGroup.provider === provider;
                              const groupDropPos = cliGroupDropTarget?.projectId === project.id
                                && cliGroupDropTarget.provider === provider
                                ? cliGroupDropTarget.position
                                : null;

                              return (
                                <div
                                  key={groupKey}
                                  className="work-cli-group"
                                  data-cli-provider={provider}
                                >
                                  <div
                                    className={`work-cli-group-header${isDraggingGroup ? ' is-dragging' : ''}${groupDropPos === 'before' ? ' is-drop-before' : ''}${groupDropPos === 'after' ? ' is-drop-after' : ''}`}
                                    draggable
                                    onDragStart={(event) => {
                                      event.stopPropagation();
                                      clearProjectDragState();
                                      const payload = { projectId: project.id, provider };
                                      dragCliGroupRef.current = payload;
                                      setDraggingCliGroup(payload);
                                      if (event.dataTransfer) {
                                        event.dataTransfer.effectAllowed = 'move';
                                        event.dataTransfer.setData(
                                          'application/x-matrius-cli-group',
                                          JSON.stringify(payload),
                                        );
                                      }
                                    }}
                                    onDragOver={(event) => {
                                      const source = dragCliGroupRef.current;
                                      if (!source || source.projectId !== project.id || source.provider === provider) {
                                        return;
                                      }
                                      event.preventDefault();
                                      event.stopPropagation();
                                      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                                      const fromIndex = cliGroups.findIndex((entry) => entry.provider === source.provider);
                                      const position = resolveDragPosition(event, fromIndex, groupIndex);
                                      setCliGroupDropTarget((prev) => (
                                        prev?.projectId === project.id
                                        && prev.provider === provider
                                        && prev.position === position
                                          ? prev
                                          : { projectId: project.id, provider, position }
                                      ));
                                    }}
                                    onDragLeave={(event) => {
                                      const nextTarget = event.relatedTarget as Node | null;
                                      if (nextTarget && event.currentTarget.contains(nextTarget)) return;
                                      setCliGroupDropTarget((prev) => (
                                        prev?.projectId === project.id && prev.provider === provider ? null : prev
                                      ));
                                    }}
                                    onDrop={(event) => {
                                      let source = dragCliGroupRef.current;
                                      if (!source && event.dataTransfer) {
                                        try {
                                          const raw = event.dataTransfer.getData('application/x-matrius-cli-group');
                                          if (raw) source = JSON.parse(raw) as { projectId: string; provider: WorkCliProvider };
                                        } catch {
                                          source = null;
                                        }
                                      }
                                      if (!source || source.projectId !== project.id || source.provider === provider) {
                                        clearCliGroupDragState();
                                        return;
                                      }
                                      event.preventDefault();
                                      event.stopPropagation();
                                      const fromIndex = cliGroups.findIndex((entry) => entry.provider === source.provider);
                                      const position = resolveDragPosition(event, fromIndex, groupIndex);
                                      clearCliGroupDragState();
                                      reorderWorkCliProviders(source.provider, provider, position);
                                    }}
                                    onDragEnd={clearCliGroupDragState}
                                  >
                                    <button
                                      type="button"
                                      className="work-cli-group-toggle"
                                      aria-expanded={hasGroupItems ? !isGroupCollapsed : undefined}
                                      onClick={() => {
                                        if (hasGroupItems) {
                                          toggleWorkCliGroupCollapsed(project.id, provider);
                                        }
                                      }}
                                    >
                                      {hasGroupItems ? (
                                        <ChevronRight
                                          size={12}
                                          strokeWidth={1.75}
                                          className="work-cli-group-chevron"
                                          aria-hidden="true"
                                        />
                                      ) : (
                                        <span className="work-cli-group-spacer" aria-hidden="true" />
                                      )}
                                      <span className="work-cli-group-icon" aria-hidden="true">
                                        <TerminalPresetIcon preset={provider} size={14} />
                                      </span>
                                      <span className="work-cli-group-label">{WORK_CLI_PROVIDER_LABELS[provider]}</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="icon-button work-cli-group-add"
                                      data-cli-provider={provider}
                                      aria-label={`新建 ${WORK_CLI_PROVIDER_LABELS[provider]} 对话`}
                                      draggable={false}
                                      disabled={openingCliKey === groupKey}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleCreateNewCliSession(project, provider);
                                      }}
                                    >
                                      <Plus size={14} strokeWidth={1.85} aria-hidden="true" />
                                    </button>
                                  </div>

                                  {hasGroupItems && !isGroupCollapsed && (
                                    <div className="work-cli-group-items">
                                        {draftTerminal && (
                                          <button
                                            key={draftTerminal.id}
                                            type="button"
                                            className={`work-cli-session-btn work-cli-session-draft${isActive && activeTerminalId === draftTerminal.id ? ' is-active' : ''}`}
                                            aria-current={isActive && activeTerminalId === draftTerminal.id ? 'true' : undefined}
                                            data-cli-provider={provider}
                                            data-cli-draft="true"
                                            data-cli-terminal-id={draftTerminal.id}
                                            title={draftTerminal.title || NEW_CLI_SESSION_TITLE}
                                            onClick={() => {
                                              writeActiveProjectId(project.id);
                                              selectWorkTerminal(draftTerminal.id);
                                            }}
                                          >
                                            <span className="work-cli-session-title">{draftTerminal.title || NEW_CLI_SESSION_TITLE}</span>
                                          </button>
                                        )}
                                        {visibleGroupSessions.map((session) => {
                                          const cliKey = workCliSessionKey(project.id, session.provider, session.id);
                                          const isSessionActive = isActive
                                            && activeTerminal?.preset === session.provider
                                            && activeTerminal?.cliSessionId === session.id;
                                          const boundTerminal = terminals.find((item) => (
                                            item.projectId === project.id
                                            && item.preset === session.provider
                                            && item.cliSessionId === session.id
                                          ));
                                          const displayTitle = isFallbackCliSessionTitle(session.title) && boundTerminal?.title === NEW_CLI_SESSION_TITLE
                                            ? NEW_CLI_SESSION_TITLE
                                            : session.title;
                                          const isUnread = Boolean(unreadCompletedCliKeys[cliKey]);
                                          return (
                                            <button
                                              key={cliKey}
                                              type="button"
                                              className={`work-cli-session-btn${isSessionActive ? ' is-active' : ''}`}
                                              aria-current={isSessionActive ? 'true' : undefined}
                                              data-cli-provider={session.provider}
                                              data-cli-session-id={session.id}
                                              data-cli-status={session.status}
                                              disabled={openingCliKey === cliKey}
                                              onClick={() => void handleOpenCliSession(project, session)}
                                            >
                                              <span className="work-cli-session-title">{displayTitle}</span>
                                              {session.status === 'running' ? (
                                                <span className="work-cli-status is-running" role="status" aria-label="加载中">
                                                  <span className="conversation-spinner" aria-hidden="true" />
                                                </span>
                                              ) : session.status === 'completed' && isUnread ? (
                                                <span
                                                  className="work-cli-status is-completed conversation-completed-indicator"
                                                  role="img"
                                                  aria-label="已完成，尚未查看"
                                                />
                                              ) : null}
                                            </button>
                                          );
                                        })}
                                        {(hasMoreInGroup || canCollapseGroupMore) && (
                                          <div className="work-project-cli-actions">
                                            {hasMoreInGroup && (
                                              <button
                                                type="button"
                                                className="work-project-show-more"
                                                disabled={cliState?.loadingMore}
                                                onClick={() => void handleShowMore(project.id, provider)}
                                              >
                                                {cliState?.loadingMore ? '正在加载…' : '显示更多'}
                                              </button>
                                            )}
                                            {canCollapseGroupMore && (
                                              <button
                                                type="button"
                                                className="work-project-show-less"
                                                onClick={() => collapseWorkCliSessions(project.id, provider)}
                                              >
                                                收起
                                              </button>
                                            )}
                                          </div>
                                        )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : null}
              </div>
            </section>
          </nav>
        </>
      )}

      {menu && menuProject && (
        <SidebarMenu
          id="work-project-menu"
          label={`项目操作：${menuProject.name}`}
          anchor={menu.anchor}
          focusReturnTarget={menu.focusTarget}
          align="end"
          dismissOnAnchorPointerDown
          rowSelector=".work-project-item"
          onClose={closeMenu}
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              (menu.focusTarget ?? menu.anchor).focus();
              setWorkProjectsError(null);
              setDialogProject(menuProject);
              closeMenu();
            }}
          >
            <Settings2 size={16} strokeWidth={1.75} aria-hidden="true" />
            项目设置
          </button>
          <button
            role="menuitem"
            type="button"
            className="danger-text"
            onClick={() => {
              (menu.focusTarget ?? menu.anchor).focus();
              setWorkProjectsError(null);
              setDeleting(menuProject);
              closeMenu();
            }}
          >
            <Icon name="trash" size={17} />
            移除项目
          </button>
        </SidebarMenu>
      )}

      {dialogProject && (
        <CreateProjectDialog
          project={dialogProject === 'create' ? null : dialogProject}
          initialHosts={hosts}
          onHostsSync={syncHosts}
          onSaved={(saved) => upsertWorkProject(saved)}
          onClose={() => setDialogProject(null)}
        />
      )}

      {deleting && (
        <Dialog
          title="移除这个项目？"
          onClose={() => { if (!busyId) setDeleting(null); }}
          className="compact-dialog"
        >
          <p className="dialog-description">仅从工作区移除「{deleting.name}」，不会删除主机上的文件。</p>
          <div className="dialog-footer">
            <button type="button" className="secondary-button" data-autofocus disabled={busyId === deleting.id} onClick={() => setDeleting(null)}>取消</button>
            <button type="button" className="danger-button" disabled={busyId === deleting.id} onClick={() => void confirmRemove()}>
              {busyId === deleting.id ? '移除中…' : '移除项目'}
            </button>
          </div>
        </Dialog>
      )}

      {cliNotice && (
        <WorkErrorDialog
          title="提示"
          message={cliNotice}
          className="work-cli-error-dialog"
          onClose={() => setCliNotice(null)}
        />
      )}
    </>
  );
}
