import { LOCAL_WORK_HOST_ID, type WorkProject } from '@contract/work-projects';
import type { WorkHost } from '@contract/work-hosts';
import { Folder, FolderPlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Icon } from '@/components/web/icon';
import { listWorkHosts } from '@/features/hosts/hosts-api';
import { useInstance } from '@/features/instance/instance-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { CreateProjectDialog } from './create-project-dialog';
import { createPreviewWorkHosts, deleteWorkProject, listWorkProjects } from './work-api';
import { useActiveProjectId, writeActiveProjectId } from './work-state';

function hostDisplayName(hostId: string, hostMap: Map<string, WorkHost>): string {
  if (hostId === LOCAL_WORK_HOST_ID) return '本机';
  const host = hostMap.get(hostId);
  if (!host) return '已移除主机';
  return host.name;
}

export function WorkSidebarPanel() {
  const instance = useInstance();
  const preview = useIsPreview();
  const activeProjectId = useActiveProjectId();

  const [projects, setProjects] = useState<WorkProject[]>([]);
  const [hosts, setHosts] = useState<WorkHost[]>(() => (preview ? createPreviewWorkHosts() : []));
  const [loaded, setLoaded] = useState(preview);
  const [collapsed, setCollapsed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const canUseServer = !preview && instance.status === 'ready';

  useEffect(() => {
    if (!canUseServer) return;
    let cancelled = false;
    Promise.all([
      listWorkProjects(instance.request),
      listWorkHosts(instance.request).catch(() => ({ items: [] as WorkHost[] })),
    ])
      .then(([projectRes, hostRes]) => {
        if (cancelled) return;
        setProjects(projectRes.items);
        setHosts(hostRes.items);
        setLoaded(true);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLoaded(true);
        setError(reason instanceof Error && reason.message ? reason.message : '读取项目列表失败。');
      });
    return () => { cancelled = true; };
  }, [canUseServer, instance.request]);

  const hostMap = useMemo(() => new Map(hosts.map((host) => [host.id, host])), [hosts]);
  const syncHosts = useCallback((nextHosts: WorkHost[]) => {
    setHosts(nextHosts);
  }, []);

  async function handleRemove(project: WorkProject) {
    if (busyId) return;
    setError(null);
    if (preview) {
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (activeProjectId === project.id) writeActiveProjectId(null);
      return;
    }
    setBusyId(project.id);
    try {
      await deleteWorkProject(instance.request, project.id, project.revision);
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (activeProjectId === project.id) writeActiveProjectId(null);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : '移除项目失败。');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <nav className="sidebar-primary" aria-label="工作操作">
        <button
          type="button"
          className="new-conversation"
          onClick={() => {
            setError(null);
            setCreateOpen(true);
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
              aria-expanded={!collapsed}
              aria-controls="sidebar-work-projects"
              onClick={() => setCollapsed((current) => !current)}
            >
              <span>项目</span>
              <Icon name="chevron" size={16} />
            </button>
          </h2>
          <div id="sidebar-work-projects" hidden={collapsed}>
            {error && <p className="work-sidebar-error" role="alert">{error}</p>}
            {!loaded && canUseServer ? (
              <p className="work-sidebar-loading" role="status">正在读取项目…</p>
            ) : projects.length > 0 ? (
              projects.map((project) => {
                const isActive = activeProjectId === project.id;
                const hostLabel = hostDisplayName(project.hostId, hostMap);
                return (
                  <div
                    key={project.id}
                    className={`work-project-item${isActive ? ' is-active' : ''}`}
                  >
                    <button
                      type="button"
                      className="work-project-select"
                      aria-current={isActive ? 'true' : undefined}
                      title={`${hostLabel} · ${project.directory}`}
                      onClick={() => writeActiveProjectId(project.id)}
                    >
                      <span className="work-project-icon" aria-hidden="true">
                        <Folder size={15} strokeWidth={1.75} />
                      </span>
                      <span className="work-project-copy">
                        <strong>{project.name}</strong>
                        <span>{hostLabel} · {project.directory}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-button work-project-delete"
                      aria-label={`移除项目：${project.name}`}
                      disabled={busyId === project.id}
                      onClick={() => void handleRemove(project)}
                    >
                      <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                );
              })
            ) : null}
          </div>
        </section>
      </nav>

      {createOpen && (
        <CreateProjectDialog
          initialHosts={hosts}
          onHostsSync={syncHosts}
          onCreated={(created) => {
            setProjects((current) => [created, ...current.filter((item) => item.id !== created.id)]);
            writeActiveProjectId(created.id);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </>
  );
}
