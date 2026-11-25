import { LOCAL_WORK_HOST_ID, type WorkHostEntry, type WorkProject } from '@contract/work-projects';
import type { WorkHost } from '@contract/work-hosts';
import type { WorkTerminalSession } from '@contract/work-terminals';
import { FolderPlus, GitBranch, LayoutPanelLeft, Plus, RefreshCw, Search, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { router, usePathname } from '@/router';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { SidebarMenu } from '@/components/web/sidebar-menu';
import { SidebarScrollingLabel } from '@/components/web/sidebar-scrolling-label';
import { listWorkHosts } from '@/features/hosts/hosts-api';
import { useFeature, useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { CreateProjectDialog } from './create-project-dialog';
import { WorkFileTree } from './work-files-panel';
import { workHref, workProjectIdIn } from './work-href';
import {
  createPreviewWorkHosts,
  deleteWorkProject,
  listWorkProjects,
  listWorkTerminals,
} from './work-api';
import { loadWorkSettings, saveWorkSettings } from './work-shell-preference';
import {
  closeWorkGit,
  closeWorkSearch,
  detectPreviewPlatform,
  getWorkState,
  hydrateWorkSettings,
  openWorkFile,
  openWorkGit,
  openWorkSearch,
  removeWorkProject,
  reorderWorkProjects,
  setWorkHosts,
  setWorkProjects,
  setWorkProjectsError,
  setWorkServerPlatform,
  setWorkTerminals,
  upsertWorkProject,
  useWorkState,
  writeActiveProjectId,
} from './work-state';

const WORK_PROJECTS_COLLAPSED_KEY = 'matrius:work-sidebar-projects-collapsed';
const WORK_FILES_COLLAPSED_KEY = 'matrius:work-sidebar-files-collapsed';

function readStoredCollapsed(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeStoredCollapsed(key: string, collapsed: boolean): void {
  try {
    if (collapsed) globalThis.localStorage?.setItem(key, '1');
    else globalThis.localStorage?.removeItem(key);
  } catch {
    // Ignore storage restrictions.
  }
}

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

export function WorkSidebarPanel({ collapsed = false }: { collapsed?: boolean }) {
  const instance = useInstance();
  const preview = useIsPreview();
  const hasGitFeature = useFeature('work-git');
  const gitEnabled = preview || hasGitFeature;
  const pathname = usePathname();
  const {
    activeProjectId,
    activeTerminalByProject,
    filesPanelOpen,
    filesPanelWidth,
    projectOrder,
    cliProviderOrder,
    terminalOrder,
    projects,
    projectsLoaded,
    projectsError,
    gitTabsByProject,
    searchTabsByProject,
    hosts,
    serverPlatform,
    defaultWindowsShellLoaded,
  } = useWorkState();

  const [projectsCollapsed, setProjectsCollapsed] = useState(() => readStoredCollapsed(WORK_PROJECTS_COLLAPSED_KEY));
  const [filesCollapsed, setFilesCollapsed] = useState(() => readStoredCollapsed(WORK_FILES_COLLAPSED_KEY));
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesRefreshTick, setFilesRefreshTick] = useState(0);
  const [dialogProject, setDialogProject] = useState<WorkProject | 'create' | null>(null);
  const [deleting, setDeleting] = useState<WorkProject | null>(null);
  const [menu, setMenu] = useState<{
    projectId: string;
    anchor: HTMLElement;
    focusTarget: HTMLElement | null;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{
    projectId: string;
    position: 'before' | 'after';
  } | null>(null);
  const dragProjectIdRef = useRef<string | null>(null);
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

  const hostMap = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const activeProject = useMemo(
    () => projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  );
  const clearProjectDragState = useCallback(() => {
    dragProjectIdRef.current = null;
    setDraggingProjectId(null);
    setProjectDropTarget(null);
  }, []);
  const syncHosts = useCallback((nextHosts: WorkHost[]) => {
    setWorkHosts(nextHosts);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuProject = menu ? projects.find((item) => item.id === menu.projectId) ?? null : null;

  const activateProject = useCallback((projectId: string, mode: 'push' | 'replace' = 'push') => {
    writeActiveProjectId(projectId);
    if (workProjectIdIn(pathname, preview) !== projectId) {
      const targetHref = workHref(projectId, preview);
      if (mode === 'replace') router.replace(targetHref);
      else router.push(targetHref);
    }
  }, [pathname, preview]);

  const handleOpenFile = useCallback((entry: WorkHostEntry) => {
    if (!activeProject) return;
    openWorkFile(activeProject.id, entry);
  }, [activeProject]);

  async function confirmRemove() {
    if (!deleting || busyId) return;
    const target = deleting;
    const shouldReplaceRoute = activeProjectId === target.id || workProjectIdIn(pathname, preview) === target.id;
    setWorkProjectsError(null);
    if (preview) {
      removeWorkProject(target.id);
      setDeleting(null);
      if (shouldReplaceRoute) {
        router.replace(workHref(getWorkState().activeProjectId, preview));
      }
      return;
    }
    setBusyId(target.id);
    try {
      await deleteWorkProject(instance.request, target.id, target.revision);
      removeWorkProject(target.id);
      setDeleting(null);
      if (shouldReplaceRoute) {
        router.replace(workHref(getWorkState().activeProjectId, preview));
      }
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
        <div
          className="work-sidebar-explorer"
          onContextMenu={(event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest('input, textarea, [contenteditable="true"]')) return;
            event.preventDefault();
          }}
        >
          <nav className="sidebar-primary" aria-label="工作操作">
            <button
              type="button"
              className={`new-conversation${activeProject && gitTabsByProject[activeProject.id] !== 'active' && searchTabsByProject[activeProject.id] !== 'active' ? ' is-active' : ''}`}
              aria-label="工作区"
              aria-pressed={Boolean(activeProject && gitTabsByProject[activeProject.id] !== 'active' && searchTabsByProject[activeProject.id] !== 'active')}
              disabled={!activeProject}
              onClick={() => {
                if (!activeProject) return;
                closeWorkSearch(activeProject.id);
                closeWorkGit(activeProject.id);
              }}
            >
              <LayoutPanelLeft size={19} strokeWidth={1.75} aria-hidden="true" />
              <span>工作区</span>
            </button>
            <button
              type="button"
              className={`new-conversation${activeProject && searchTabsByProject[activeProject.id] === 'active' ? ' is-active' : ''}`}
              aria-label="项目内全局查找"
              aria-pressed={Boolean(activeProject && searchTabsByProject[activeProject.id] === 'active')}
              disabled={!activeProject}
              onClick={() => {
                if (!activeProject) return;
                if (searchTabsByProject[activeProject.id] === 'active') {
                  closeWorkSearch(activeProject.id);
                } else {
                  openWorkSearch(activeProject.id);
                }
              }}
            >
              <Search size={19} strokeWidth={1.75} aria-hidden="true" />
              <span>查找</span>
            </button>
            {gitEnabled && (
              <button
                type="button"
                className={`new-conversation${activeProject && gitTabsByProject[activeProject.id] === 'active' ? ' is-active' : ''}`}
                aria-label="打开 Git 查看器"
                aria-pressed={Boolean(activeProject && gitTabsByProject[activeProject.id] === 'active')}
                disabled={!activeProject}
                onClick={() => {
                  if (!activeProject) return;
                  if (gitTabsByProject[activeProject.id] === 'active') {
                    closeWorkGit(activeProject.id);
                  } else {
                    openWorkGit(activeProject.id);
                  }
                }}
              >
                <GitBranch size={19} strokeWidth={1.75} aria-hidden="true" />
                <span>Git</span>
              </button>
            )}
          </nav>

          <section className="work-sidebar-projects-section" aria-label="项目列表">
            <div className="work-sidebar-group-header">
              <h2 className="sidebar-section-label">
                <button
                  type="button"
                  aria-expanded={!projectsCollapsed}
                  aria-controls="sidebar-work-projects"
                  onClick={() => setProjectsCollapsed((current) => {
                    const next = !current;
                    writeStoredCollapsed(WORK_PROJECTS_COLLAPSED_KEY, next);
                    return next;
                  })}
                >
                  <span>项目</span>
                  <Icon name="chevron" size={16} />
                </button>
              </h2>
              <button
                type="button"
                className="icon-button work-sidebar-group-action"
                aria-label="创建项目"
                title="创建项目"
                onClick={() => {
                  setWorkProjectsError(null);
                  setDialogProject('create');
                }}
              >
                <Plus size={15} strokeWidth={1.85} aria-hidden="true" />
              </button>
            </div>
            <div id="sidebar-work-projects" className="work-sidebar-projects-list" hidden={projectsCollapsed}>
              {projectsError && <p className="work-sidebar-error" role="alert">{projectsError}</p>}
              {!projectsLoaded && canUseServer ? (
                <p className="work-sidebar-loading" role="status">正在读取项目…</p>
              ) : projects.length > 0 ? (
                projects.map((project, projectIndex) => {
                  const isActive = activeProject?.id === project.id;
                  const hostLabel = hostDisplayName(project.hostId, hostMap);
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
                    <div
                      key={project.id}
                      className={`work-project-item${isActive ? ' is-active' : ''}${menuProject?.id === project.id ? ' menu-open' : ''}${isDraggingProject ? ' is-dragging' : ''}${projectDropPos === 'before' ? ' is-drop-before' : ''}${projectDropPos === 'after' ? ' is-drop-after' : ''}`}
                      data-project-id={project.id}
                      draggable={busyId !== project.id}
                      onDragStart={(event) => {
                        if (busyId === project.id) {
                          event.preventDefault();
                          return;
                        }
                        closeMenu();
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
                        className="work-project-select"
                        aria-current={isActive ? 'true' : undefined}
                        title={`${hostLabel} · ${project.directory}`}
                        onClick={() => activateProject(project.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                            event.preventDefault();
                            const rowEl = event.currentTarget.closest<HTMLElement>('.work-project-item') ?? event.currentTarget;
                            openProjectMenu(rowEl, event.currentTarget);
                          }
                        }}
                      >
                        <SidebarScrollingLabel className="work-project-name" title={project.name} />
                        {project.hostId !== LOCAL_WORK_HOST_ID && (
                          <span className="work-project-host">{hostLabel}</span>
                        )}
                      </button>
                    </div>
                  );
                })
              ) : null}
            </div>
          </section>

          <section className="conversation-group work-sidebar-files-section" aria-label="项目文件">
            <div className="work-sidebar-files-header">
              <h2 className="sidebar-section-label">
                <button
                  type="button"
                  aria-expanded={!filesCollapsed}
                  aria-controls="sidebar-work-files"
                  title={activeProject?.directory}
                  onClick={() => setFilesCollapsed((current) => {
                    const next = !current;
                    writeStoredCollapsed(WORK_FILES_COLLAPSED_KEY, next);
                    return next;
                  })}
                >
                  <span>文件</span>
                  <Icon name="chevron" size={16} />
                </button>
              </h2>
              {activeProject && (
                <span className="work-sidebar-files-project" title={activeProject.directory}>
                  {activeProject.name}
                </span>
              )}
              {activeProject && (
                <button
                  type="button"
                  className="icon-button work-sidebar-files-refresh"
                  aria-label="刷新工作目录"
                  disabled={filesLoading}
                  onClick={() => setFilesRefreshTick((tick) => tick + 1)}
                >
                  <RefreshCw size={14} strokeWidth={1.75} className={filesLoading ? 'loading-spinner' : undefined} aria-hidden="true" />
                </button>
              )}
            </div>
            <div id="sidebar-work-files" className="work-sidebar-files-body" hidden={filesCollapsed}>
              <WorkFileTree
                project={activeProject}
                onOpenFile={handleOpenFile}
                refreshTick={filesRefreshTick}
                onLoadingChange={setFilesLoading}
              />
            </div>
          </section>
        </div>
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
          onSaved={(saved) => {
            const existed = projects.some((item) => item.id === saved.id);
            upsertWorkProject(saved);
            if (!existed && workProjectIdIn(pathname, preview) !== saved.id) {
              const currentUrlProject = workProjectIdIn(pathname, preview);
              activateProject(saved.id, currentUrlProject ? 'push' : 'replace');
            }
          }}
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
    </>
  );
}
