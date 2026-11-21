import {
  LOCAL_WORK_HOST_ID,
  deriveProjectName,
  normalizeProjectProxyUrl,
  type WorkProject,
} from '@contract/work-projects';
import type { WorkHost } from '@contract/work-hosts';
import {
  FolderOpen,
  Laptop,
  Server,
  Terminal,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { SelectField, type SelectFieldOption } from '@/components/web/select-field';
import { listWorkHosts } from '@/features/hosts/hosts-api';
import { useInstance } from '@/features/instance/instance-state';
import { rememberWorkspacePath } from '@/features/settings/settings-return';
import { writeSidebarTab } from '@/features/chat/sidebar-mode';
import { useIsPreview } from '@/features/workspace/preview-context';
import { router, usePathname } from '@/router';
import { DirectoryBrowserDialog } from './directory-browser-dialog';
import { createPreviewWorkHosts, createWorkProject, updateWorkProject } from './work-api';
import { WorkErrorDialog } from './work-error-dialog';

type Props = {
  project?: WorkProject | null;
  initialHosts?: WorkHost[];
  onHostsSync?: (hosts: WorkHost[]) => void;
  onSaved: (project: WorkProject) => void;
  onClose: () => void;
};

function sortHosts(items: WorkHost[]): WorkHost[] {
  return [...items].sort((a, b) => {
    if (a.status === 'connected' && b.status !== 'connected') return -1;
    if (a.status !== 'connected' && b.status === 'connected') return 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

function defaultHostSelection(items: WorkHost[]): string {
  const firstConnected = items.find((item) => item.status === 'connected');
  return firstConnected?.id ?? LOCAL_WORK_HOST_ID;
}

function hostSummaryLabel(host: WorkHost): string {
  return host.status === 'error' ? `${host.name} · 异常` : host.name;
}

export function CreateProjectDialog({ project = null, initialHosts, onHostsSync, onSaved, onClose }: Props) {
  const instance = useInstance();
  const preview = useIsPreview();
  const pathname = usePathname();
  const editing = Boolean(project);

  const seedHosts = useMemo(
    () => (preview ? sortHosts(initialHosts ?? createPreviewWorkHosts()) : sortHosts(initialHosts ?? [])),
    [initialHosts, preview],
  );
  const [hosts, setHosts] = useState<WorkHost[]>(seedHosts);
  const [name, setName] = useState(() => project?.name ?? '');
  const [hostId, setHostId] = useState<string>(() => project?.hostId ?? defaultHostSelection(seedHosts));
  const [directory, setDirectory] = useState(() => project?.directory ?? '');
  const [proxyUrl, setProxyUrl] = useState(() => project?.proxyUrl ?? '');
  const [browseDir, setBrowseDir] = useState(() => project?.directory ?? '');
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canFetchHosts = !preview && instance.status === 'ready';

  useEffect(() => {
    if (!canFetchHosts) return;
    let cancelled = false;
    const controller = new AbortController();
    listWorkHosts(instance.request, controller.signal)
      .then((res) => {
        if (cancelled) return;
        const sorted = sortHosts(res.items);
        setHosts(sorted);
        onHostsSync?.(sorted);
        if (!project) {
          setHostId((current) => (current === LOCAL_WORK_HOST_ID ? defaultHostSelection(sorted) : current));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [canFetchHosts, instance.request, onHostsSync, project]);

  const hostOptions: SelectFieldOption[] = useMemo(() => {
    const items: SelectFieldOption[] = [
      {
        id: LOCAL_WORK_HOST_ID,
        label: '本机',
        icon: <Laptop size={15} strokeWidth={1.75} />,
      },
    ];
    for (const host of hosts) {
      items.push({
        id: host.id,
        label: hostSummaryLabel(host),
        icon: host.kind === 'wsl'
          ? <Terminal size={15} strokeWidth={1.75} />
          : <Server size={15} strokeWidth={1.75} />,
      });
    }
    return items;
  }, [hosts]);

  const activeHostLabel = useMemo(() => {
    if (hostId === LOCAL_WORK_HOST_ID) return '本机';
    const target = hosts.find((item) => item.id === hostId);
    if (!target) return '已选主机';
    return `${target.kind === 'wsl' ? 'WSL' : 'SSH'} · ${target.name}`;
  }, [hostId, hosts]);

  function openHostSettings() {
    if (saving) return;
    rememberWorkspacePath(pathname);
    writeSidebarTab('work');
    setBrowsing(false);
    onClose();
    router.push((preview ? '/mock/chat/settings/hosts' : '/settings/hosts'));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setError(null);
    const trimmedDir = directory.trim();
    if (!trimmedDir) {
      setError('请先选择项目目录。');
      return;
    }
    let normalizedProxy: string;
    try {
      normalizedProxy = normalizeProjectProxyUrl(proxyUrl);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : '请输入合法的网络代理地址。');
      return;
    }
    const trimmedName = name.trim();

    if (preview) {
      const now = Date.now();
      const resolvedName = trimmedName || deriveProjectName(trimmedDir);
      if (project) {
        onSaved({
          ...project,
          name: resolvedName,
          hostId,
          directory: trimmedDir,
          ...(normalizedProxy ? { proxyUrl: normalizedProxy } : { proxyUrl: undefined }),
          revision: project.revision + 1,
          updatedAt: now,
        });
      } else {
        onSaved({
          id: `mock-project-${now}`,
          name: resolvedName,
          hostId,
          directory: trimmedDir,
          ...(normalizedProxy ? { proxyUrl: normalizedProxy } : {}),
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      onClose();
      return;
    }

    setSaving(true);
    try {
      const saved = project
        ? await updateWorkProject(instance.request, project.id, {
            hostId,
            directory: trimmedDir,
            proxyUrl: normalizedProxy,
            ...(trimmedName ? { name: trimmedName } : {}),
            baseRevision: project.revision,
          })
        : await createWorkProject(instance.request, {
            hostId,
            directory: trimmedDir,
            ...(normalizedProxy ? { proxyUrl: normalizedProxy } : {}),
            ...(trimmedName ? { name: trimmedName } : {}),
          });
      onSaved(saved);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : `${editing ? '保存' : '创建'}项目失败，请重试。`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog
        title={editing ? '项目设置' : '创建项目'}
        onClose={() => { if (!saving) onClose(); }}
        className="compact-dialog work-project-dialog"
      >
        <form className="provider-edit-form" onSubmit={(event) => void handleSubmit(event)}>
          <fieldset disabled={saving}>
            {editing && (
              <label className="model-form-field">
                项目名称
                <input
                  className="text-field"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={directory ? deriveProjectName(directory) : '项目名称'}
                  maxLength={120}
                />
              </label>
            )}

            <div className="work-field-block">
              <div className="work-field-header">
                <span className="work-field-title">主机</span>
                <button
                  type="button"
                  className="work-settings-link"
                  onClick={openHostSettings}
                >
                  主机设置
                </button>
              </div>
              <SelectField
                label="主机"
                hideLabel
                value={hostId}
                options={hostOptions}
                onChange={(nextHostId) => {
                  if (nextHostId !== hostId) {
                    setHostId(nextHostId);
                    setDirectory('');
                    setBrowseDir('');
                    setError(null);
                  }
                }}
              />
            </div>

            <div className="work-field-block">
              <span className="work-field-title">项目目录</span>
              <button
                type="button"
                className={`work-dir-picker${directory ? ' has-value' : ''}`}
                aria-label="选择项目目录"
                onClick={() => {
                  setError(null);
                  setBrowsing(true);
                }}
              >
                <span className="work-dir-picker-icon" aria-hidden="true">
                  <FolderOpen size={15} strokeWidth={1.75} />
                </span>
                <span className="work-dir-picker-text">
                  {directory || '选择项目目录'}
                </span>
              </button>
            </div>

            <div className="work-field-block">
              <div className="work-field-header">
                <label className="work-field-title" htmlFor="work-project-proxy-input">网络代理</label>
                <span className="work-field-optional">可选</span>
              </div>
              <input
                id="work-project-proxy-input"
                className="text-field work-proxy-input"
                value={proxyUrl}
                onChange={(event) => setProxyUrl(event.target.value)}
                placeholder="例如：http://127.0.0.1:7890（留空不使用代理）"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={500}
              />
            </div>

            <div className="dialog-footer">
              <button type="button" className="secondary-button" onClick={onClose}>取消</button>
              <button type="submit" className="primary-button" disabled={saving}>
                {saving
                  ? (editing ? '保存中…' : '创建中…')
                  : (editing ? '保存' : '创建项目')}
              </button>
            </div>
          </fieldset>
        </form>
      </Dialog>

      {error && (
        <WorkErrorDialog
          title={editing ? '无法保存项目' : '提示'}
          message={error}
          className="work-project-error-dialog"
          onClose={() => setError(null)}
        />
      )}

      {browsing && (
        <DirectoryBrowserDialog
          hostId={hostId}
          hostLabel={activeHostLabel}
          initialPath={browseDir}
          onSelect={(chosen, currentBrowseDir) => {
            setDirectory(chosen);
            if (currentBrowseDir !== undefined) setBrowseDir(currentBrowseDir);
            setError(null);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}
