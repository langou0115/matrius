import { LOCAL_WORK_HOST_ID, type WorkProject } from '@contract/work-projects';
import type { WorkHost } from '@contract/work-hosts';
import type { WorkTerminalSession } from '@contract/work-terminals';
import { FolderPlus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { SidebarMenu } from '@/components/web/sidebar-menu';
import { listWorkHosts } from '@/features/hosts/hosts-api';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { CreateProjectDialog } from './create-project-dialog';
import {
  createPreviewWorkHosts,
  deleteWorkProject,
  listWorkProjects,
  listWorkTerminals,
} from './work-api';
import { loadWorkSettings, saveWorkSettings } from './work-shell-preference';
import {
  detectPreviewPlatform,
  hydrateWorkSettings,
  removeWorkProject,
  setWorkHosts,
  setWorkProjects,
  setWorkProjectsError,
  setWorkServerPlatform,
  setWorkTerminals,
  upsertWorkProject,
  useWorkState,
  writeActiveProjectId,
} from './work-state';

function hostDisplayName(hostId: string, hostMap: Map<string, WorkHost>): string {
  if (hostId === LOCAL_WORK_HOST_ID) return '本机';
  const host = hostMap.get(hostId);
  if (!host) return '已移除主机';
  return host.name;
}

export function WorkSidebarPanel({ collapsed = false }: { collapsed?: boolean }) {
  const instance = useInstance();
  const preview = useIsPreview();
  const {
    activeProjectId,
    activeTerminalByProject,
    projects,
    projectsLoaded,
    projectsError,
    hosts,
    serverPlatform,
    defaultWindowsShellLoaded,
  } = useWorkState();

  const [groupCollapsed, setGroupCollapsed] = useState(false);
  const [dialogProject, setDialogProject] = useState<WorkProject | 'create' | null>(null);
  const [deleting, setDeleting] = useState<WorkProject | null>(null);
  const [menu, setMenu] = useState<{ projectId: string; anchor: HTMLButtonElement } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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
        setWorkProjects(projectRes.items);
        setWorkHosts(hostRes.items);
        setWorkTerminals(terminalRes.items);
        if (terminalRes.platform) setWorkServerPlatform(terminalRes.platform);
        if (workSettings) {
          lastSavedSelectionRef.current = JSON.stringify({
            activeProjectId: workSettings.activeProjectId,
            activeTerminals: workSettings.activeTerminals,
          });
          hydrateWorkSettings(workSettings);
        }
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
    });
    if (serialized === lastSavedSelectionRef.current) return;
    const timer = setTimeout(() => {
      lastSavedSelectionRef.current = serialized;
      void saveWorkSettings(instance.request, {
        activeProjectId,
        activeTerminals: activeTerminalByProject,
      }).catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [activeProjectId, activeTerminalByProject, canUseServer, defaultWindowsShellLoaded, instance.request, projectsLoaded]);

  const hostMap = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const syncHosts = useCallback((nextHosts: WorkHost[]) => {
    setWorkHosts(nextHosts);
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const menuProject = menu ? projects.find((item) => item.id === menu.projectId) ?? null : null;

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
                  projects.map((project) => {
                    const isActive = activeProjectId === project.id;
                    const hostLabel = hostDisplayName(project.hostId, hostMap);
                    return (
                      <div
                        key={project.id}
                        className={`work-project-item${isActive ? ' is-active' : ''}${menuProject?.id === project.id ? ' menu-open' : ''}`}
                      >
                        <button
                          type="button"
                          className="work-project-select"
                          aria-current={isActive ? 'true' : undefined}
                          title={`${hostLabel} · ${project.directory}`}
                          onClick={() => writeActiveProjectId(project.id)}
                        >
                          <span className="work-project-name">{project.name}</span>
                          {project.hostId !== LOCAL_WORK_HOST_ID && (
                            <span className="work-project-host">{hostLabel}</span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="icon-button work-project-more"
                          aria-label={`项目设置：${project.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menuProject?.id === project.id}
                          aria-controls={menuProject?.id === project.id ? 'work-project-menu' : undefined}
                          disabled={busyId === project.id}
                          onClick={(event) => {
                            setMenu(menuProject?.id === project.id ? null : { projectId: project.id, anchor: event.currentTarget });
                          }}
                        >
                          <Icon name="more" size={17} />
                        </button>
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
          rowSelector=".work-project-item"
          onClose={closeMenu}
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              menu.anchor.focus();
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
              menu.anchor.focus();
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
    </>
  );
}
