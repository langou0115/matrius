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
import { resolveWorkTerminalCommand, type WorkProject } from '@contract/work-projects';
import { defaultTerminalCommand, type WorkTerminalSession } from '@contract/work-terminals';
import { ChevronRight, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { router, usePathname } from '@/router';

import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { CreateProjectDialog } from './create-project-dialog';
import { TerminalPresetIcon } from './terminal-preset-icon';
import {
  createPreviewCliSessions,
  createWorkTerminal,
  listProjectCliSessions,
  updateWorkTerminal,
} from './work-api';
import { WorkErrorDialog } from './work-error-dialog';
import { workHref, workProjectIdIn } from './work-href';
import {
  MAX_WORK_FILES_WIDTH,
  MIN_WORK_FILES_WIDTH,
  addWorkTerminal,
  bumpCliSessionsRefresh,
  collapseWorkCliSessions,
  getWorkState,
  markWorkCliSessionRead,
  reorderWorkCliProviders,
  selectWorkTerminal,
  setWorkCliGroupCollapsed,
  setWorkProjectCliSessions,
  setWorkProjectCliSessionsError,
  setWorkProjectCliSessionsLoading,
  showMoreWorkCliSessions,
  toggleWorkCliGroupCollapsed,
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

export function WorkCliPanel({
  project,
  width,
  resizing = false,
  getMaxWidth,
  onStartResize,
  onResize,
  onClose,
}: {
  project: WorkProject | null;
  width: number | null;
  resizing?: boolean;
  getMaxWidth: () => number;
  onStartResize: (startX: number, startWidth: number) => void;
  onResize: (nextWidth: number, maxWidth: number) => void;
  onClose: () => void;
}) {
  const instance = useInstance();
  const preview = useIsPreview();
  const pathname = usePathname();
  const panelRef = useRef<HTMLElement>(null);
  const dragCliGroupRef = useRef<{ projectId: string; provider: WorkCliProvider } | null>(null);
  const pendingNewCliKeysRef = useRef(new Set<string>());

  const {
    activeTerminalId,
    cliProviderOrder,
    collapsedCliGroups,
    cliVisibleCounts,
    cliSessionsByProject,
    unreadCompletedCliKeys,
    cliRefreshTick,
    hosts,
    terminals,
    hostUnlockVersion,
  } = useWorkState();

  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [openingCliKey, setOpeningCliKey] = useState<string | null>(null);
  const [cliNotice, setCliNotice] = useState<string | null>(null);
  const [draggingCliGroup, setDraggingCliGroup] = useState<{
    projectId: string;
    provider: WorkCliProvider;
  } | null>(null);
  const [cliGroupDropTarget, setCliGroupDropTarget] = useState<{
    projectId: string;
    provider: WorkCliProvider;
    position: 'before' | 'after';
  } | null>(null);

  const canUseServer = !preview && instance.status === 'ready';
  const projectId = project?.id ?? null;

  const readBaseWidth = useCallback(() => {
    const rectWidth = panelRef.current?.getBoundingClientRect().width ?? 0;
    if (rectWidth > 0) return rectWidth;
    return width ?? 320;
  }, [width]);

  function startResize(startX: number) {
    onStartResize(startX, readBaseWidth());
  }

  const fetchProjectCliSessions = useCallback(async (
    targetProjectId: string,
    limit: number,
    options: { silent?: boolean; loadingMore?: boolean } = {},
  ) => {
    if (preview) {
      setWorkProjectCliSessions(targetProjectId, createPreviewCliSessions(targetProjectId), limit);
      return;
    }
    if (!canUseServer) return;
    if (!options.silent) {
      setWorkProjectCliSessionsLoading(targetProjectId, {
        loadingMore: options.loadingMore,
        requestedLimit: limit,
      });
    }
    try {
      const result = await listProjectCliSessions(instance.request, targetProjectId, limit);
      const patches = setWorkProjectCliSessions(targetProjectId, result, limit);
      for (const item of patches) {
        void updateWorkTerminal(instance.request, item.terminalId, item.patch).catch(() => {});
      }
    } catch (reason) {
      if (!options.silent || !getWorkState().cliSessionsByProject[targetProjectId]?.loaded) {
        setWorkProjectCliSessionsError(
          targetProjectId,
          reason instanceof Error && reason.message ? reason.message : '读取 CLI 对话失败。',
        );
      }
    }
  }, [canUseServer, instance.request, preview]);

  // Load active project's CLI sessions immediately on project switch, refresh tick, or host unlock.
  useEffect(() => {
    if (!projectId) return;
    const current = getWorkState().cliSessionsByProject[projectId];
    if (preview) {
      if (!current?.loaded) {
        setWorkProjectCliSessions(projectId, createPreviewCliSessions(projectId), CLI_SESSIONS_DEFAULT_FETCH_LIMIT);
      }
      return;
    }
    if (!canUseServer) return;
    const limit = current?.requestedLimit ?? CLI_SESSIONS_DEFAULT_FETCH_LIMIT;
    void fetchProjectCliSessions(projectId, limit, { silent: Boolean(current?.loaded) });
  }, [canUseServer, cliRefreshTick, fetchProjectCliSessions, hostUnlockVersion, preview, projectId]);

  // Periodically poll active project's CLI sessions while visible.
  useEffect(() => {
    if (preview || !canUseServer || !projectId) return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const hasFastCliPoll = () => {
      const currentState = getWorkState();
      if (currentState.terminals.some((item) => (
        item.projectId === projectId
        && item.preset !== 'shell'
        && (!item.cliSessionId || item.status === 'running')
      ))) {
        return true;
      }
      return (currentState.cliSessionsByProject[projectId]?.items ?? []).some((item) => item.status === 'running');
    };

    const refreshActive = (silent: boolean) => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const current = getWorkState().cliSessionsByProject[projectId];
      const limit = current?.requestedLimit ?? CLI_SESSIONS_DEFAULT_FETCH_LIMIT;
      void fetchProjectCliSessions(projectId, limit, { silent });
    };

    const scheduleNext = () => {
      if (disposed) return;
      const delay = hasFastCliPoll() ? CLI_POLL_FAST_INTERVAL_MS : CLI_POLL_INTERVAL_MS;
      timer = setTimeout(() => {
        refreshActive(true);
        scheduleNext();
      }, delay);
    };

    scheduleNext();
    const onVisibility = () => {
      if (!document.hidden) refreshActive(true);
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
  }, [canUseServer, fetchProjectCliSessions, preview, projectId]);

  const clearCliGroupDragState = useCallback(() => {
    dragCliGroupRef.current = null;
    setDraggingCliGroup(null);
    setCliGroupDropTarget(null);
  }, []);

  const normalizedProviderOrder = useMemo(
    () => normalizeWorkCliProviderOrder(cliProviderOrder),
    [cliProviderOrder],
  );
  const activeTerminal = activeTerminalId
    ? terminals.find((item) => item.id === activeTerminalId) ?? null
    : null;
  const cliState = projectId ? cliSessionsByProject[projectId] : undefined;

  const activateProject = useCallback((targetProjectId: string) => {
    writeActiveProjectId(targetProjectId);
    if (workProjectIdIn(pathname, preview) !== targetProjectId) {
      router.push(workHref(targetProjectId, preview));
    }
  }, [pathname, preview]);

  async function handleOpenCliSession(targetProject: WorkProject, session: WorkCliSession) {
    const key = workCliSessionKey(targetProject.id, session.provider, session.id);
    if (openingCliKey === key) return;
    markWorkCliSessionRead(targetProject.id, session.provider, session.id);

    const existing = terminals.find((item) => (
      item.projectId === targetProject.id
      && item.preset === session.provider
      && item.cliSessionId === session.id
      && (item.status === 'running' || item.status === 'restored')
    )) ?? terminals.find((item) => (
      item.projectId === targetProject.id
      && item.preset === session.provider
      && item.cliSessionId === session.id
    ));
    if (existing) {
      selectWorkTerminal(existing.id);
      if (workProjectIdIn(pathname, preview) !== targetProject.id) {
        router.push(workHref(targetProject.id, preview));
      }
      return;
    }

    activateProject(targetProject.id);
    if (preview) {
      addWorkTerminal(createPreviewResumedTerminal(targetProject, session));
      return;
    }

    setOpeningCliKey(key);
    try {
      const created = await createWorkTerminal(instance.request, {
        projectId: targetProject.id,
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

  async function handleCreateNewCliSession(targetProject: WorkProject, provider: WorkCliProvider) {
    const newKey = workCliGroupKey(targetProject.id, provider);
    if (pendingNewCliKeysRef.current.has(newKey)) return;

    setWorkCliGroupCollapsed(targetProject.id, provider, false);

    const currentTerminals = getWorkState().terminals;
    const existing = currentTerminals.find((item) => (
      item.projectId === targetProject.id
      && item.preset === provider
      && !item.cliSessionId
    ));
    if (existing) {
      activateProject(targetProject.id);
      selectWorkTerminal(existing.id);
      return;
    }

    activateProject(targetProject.id);
    if (preview) {
      addWorkTerminal(createPreviewNewCliTerminal(targetProject, provider));
      bumpCliSessionsRefresh();
      return;
    }

    pendingNewCliKeysRef.current.add(newKey);
    setOpeningCliKey(newKey);
    try {
      const created = await createWorkTerminal(instance.request, {
        projectId: targetProject.id,
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

  async function handleShowMore(targetProjectId: string, provider: WorkCliProvider) {
    const current = cliSessionsByProject[targetProjectId];
    const nextVisible = showMoreWorkCliSessions(targetProjectId, provider, CLI_SESSIONS_PAGE_STEP);
    const providerCount = current
      ? current.items.filter((item) => item.provider === provider).length
      : 0;
    if (!preview && canUseServer && current && nextVisible > providerCount && current.hasMore && !current.loadingMore) {
      const nextLimit = Math.min(200, current.requestedLimit + CLI_FETCH_PAGE_STEP);
      await fetchProjectCliSessions(targetProjectId, nextLimit, { loadingMore: true });
    }
  }

  const cliGroups = useMemo(() => {
    if (!project) return [];
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
    return normalizedProviderOrder.map((provider) => ({
      provider,
      sessions: sessionsByProvider.get(provider) ?? [],
      draftTerminal: draftTerminalByProvider.get(provider) ?? null,
    }));
  }, [cliState?.items, normalizedProviderOrder, project, terminals]);

  return (
    <aside ref={panelRef} className="research-panel work-files-panel work-cli-panel" aria-label="AI 对话">
      <div
        className={`work-files-resizer${resizing ? ' is-dragging' : ''}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整 AI 对话栏宽度"
        aria-valuemin={MIN_WORK_FILES_WIDTH}
        aria-valuemax={MAX_WORK_FILES_WIDTH}
        aria-valuenow={Math.round(width ?? 300)}
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== undefined && event.button !== 0) return;
          event.preventDefault();
          startResize(event.clientX);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const step = event.shiftKey ? 32 : 16;
          const delta = event.key === 'ArrowLeft' ? step : -step;
          const max = getMaxWidth();
          onResize(readBaseWidth() + delta, max);
        }}
      />
      <header className="research-panel-header work-cli-panel-header">
        {project && (
          <button
            type="button"
            className="icon-button work-cli-panel-settings-btn"
            aria-label="AI 配置"
            title="AI 配置"
            onClick={() => setAiConfigOpen(true)}
          >
            <Settings2 size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        <div className="work-files-header-actions">
          {project && (
            <button
              type="button"
              className="icon-button"
              aria-label="刷新 CLI 对话"
              title="刷新 CLI 对话"
              disabled={cliState?.loading}
              onClick={() => bumpCliSessionsRefresh()}
            >
              <RefreshCw size={15} strokeWidth={1.75} className={cliState?.loading ? 'loading-spinner' : undefined} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="关闭 AI 对话"
            title="关闭 AI 对话"
            onClick={onClose}
          >
            <X size={17} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="research-panel-body work-cli-panel-body">
        {!project ? (
          <p className="research-empty">在左侧选择项目后管理 AI 对话</p>
        ) : (
          <div className="work-cli-panel-groups" role="region" aria-label={`${project.name} CLI 对话`}>
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
                          className={`work-cli-session-btn work-cli-session-draft${activeTerminalId === draftTerminal.id ? ' is-active' : ''}`}
                          aria-current={activeTerminalId === draftTerminal.id ? 'true' : undefined}
                          data-cli-provider={provider}
                          data-cli-draft="true"
                          data-cli-terminal-id={draftTerminal.id}
                          title={draftTerminal.title || NEW_CLI_SESSION_TITLE}
                          onClick={() => {
                            activateProject(project.id);
                            selectWorkTerminal(draftTerminal.id);
                          }}
                        >
                          <span className="work-cli-session-title">{draftTerminal.title || NEW_CLI_SESSION_TITLE}</span>
                        </button>
                      )}
                      {visibleGroupSessions.map((session) => {
                        const cliKey = workCliSessionKey(project.id, session.provider, session.id);
                        const isSessionActive = activeTerminal?.projectId === project.id
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
      {aiConfigOpen && project && (
        <CreateProjectDialog
          project={project}
          aiConfigOnly
          initialHosts={hosts}
          onSaved={(saved) => upsertWorkProject(saved)}
          onClose={() => setAiConfigOpen(false)}
        />
      )}
      {cliNotice && (
        <WorkErrorDialog
          title="提示"
          message={cliNotice}
          className="work-cli-error-dialog"
          onClose={() => setCliNotice(null)}
        />
      )}
    </aside>
  );
}
