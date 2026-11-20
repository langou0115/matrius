import { LOCAL_WORK_HOST_ID, type WorkProject } from '@contract/work-projects';
import type { WorkHost } from '@contract/work-hosts';
import {
  ArrowUpRight,
  ChevronRight,
  FolderOpen,
  Laptop,
  Server,
  Settings2,
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
import { createPreviewWorkHosts, createWorkProject } from './work-api';

type Props = {
  initialHosts?: WorkHost[];
  onHostsSync?: (hosts: WorkHost[]) => void;
  onCreated: (project: WorkProject) => void;
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
  const kindText = host.kind === 'wsl' ? 'WSL' : 'SSH';
  const statusText = host.status === 'connected' ? ' · 已连接' : host.status === 'error' ? ' · 异常' : '';
  return `${host.name}（${kindText}${statusText}）`;
}

function hostDetailHint(hostId: string, hosts: WorkHost[]): string {
  if (hostId === LOCAL_WORK_HOST_ID) {
    return '使用当前运行环境（本机）文件系统';
  }
  const host = hosts.find((item) => item.id === hostId);
  if (!host) return '来自「设置 → 工作 → 主机」';
  if (host.kind === 'wsl') {
    return `WSL 发行版：${host.distro}${host.username ? ` · 用户 ${host.username}` : ''}`;
  }
  const userPrefix = host.username ? `${host.username}@` : '';
  return `SSH 主机：${userPrefix}${host.host}:${host.port}`;
}

export function CreateProjectDialog({ initialHosts, onHostsSync, onCreated, onClose }: Props) {
  const instance = useInstance();
  const preview = useIsPreview();
  const pathname = usePathname();

  const seedHosts = useMemo(
    () => (preview ? sortHosts(initialHosts ?? createPreviewWorkHosts()) : sortHosts(initialHosts ?? [])),
    [initialHosts, preview],
  );
  const [hosts, setHosts] = useState<WorkHost[]>(seedHosts);
  const [hostsLoaded, setHostsLoaded] = useState(() => preview || instance.status !== 'ready');
  const [hostId, setHostId] = useState<string>(() => defaultHostSelection(seedHosts));
  const [directory, setDirectory] = useState('');
  const [browseDir, setBrowseDir] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canFetchHosts = !preview && instance.status === 'ready';
  const loadingHosts = canFetchHosts && !hostsLoaded;

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
        setHostsLoaded(true);
        setHostId((current) => (current === LOCAL_WORK_HOST_ID ? defaultHostSelection(sorted) : current));
      })
      .catch(() => {
        if (!cancelled) setHostsLoaded(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [canFetchHosts, instance.request, onHostsSync]);

  const hostOptions: SelectFieldOption[] = useMemo(() => {
    const items: SelectFieldOption[] = [
      {
        id: LOCAL_WORK_HOST_ID,
        label: '本机（当前主机）',
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

    if (preview) {
      const now = Date.now();
      const parts = trimmedDir.replace(/[\\/]+$/u, '').split(/[\\/]/u).filter(Boolean);
      onCreated({
        id: `mock-project-${now}`,
        name: parts.at(-1) ?? trimmedDir,
        hostId,
        directory: trimmedDir,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      onClose();
      return;
    }

    setSaving(true);
    try {
      const created = await createWorkProject(instance.request, {
        hostId,
        directory: trimmedDir,
      });
      onCreated(created);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : '创建项目失败，请重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog
        title="创建项目"
        onClose={() => { if (!saving) onClose(); }}
        className="model-form-dialog work-project-dialog"
      >
        <p className="dialog-description work-project-intro">选择运行环境主机与项目目录，快速建立工作项目。</p>
        <form className="provider-edit-form" onSubmit={(event) => void handleSubmit(event)}>
          <fieldset disabled={saving}>
            <div className="work-field-block">
              <div className="work-field-header">
                <span className="work-field-title">主机</span>
                <button
                  type="button"
                  className="work-settings-link"
                  onClick={openHostSettings}
                >
                  <Settings2 size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>设置 → 工作 → 主机</span>
                  <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden="true" />
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
              <span className="work-field-hint">
                {loadingHosts ? '正在同步主机配置…' : hostDetailHint(hostId, hosts)}
              </span>
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
                <ChevronRight size={16} strokeWidth={1.75} className="work-dir-picker-chevron" aria-hidden="true" />
              </button>
              <span className="work-field-hint">点击选择所选主机上的项目目录。</span>
            </div>

            {error && <p className="model-form-error" role="alert">{error}</p>}

            <div className="dialog-footer">
              <button type="button" className="secondary-button" onClick={onClose}>取消</button>
              <button type="submit" className="primary-button" disabled={saving}>
                {saving ? '创建中…' : '创建项目'}
              </button>
            </div>
          </fieldset>
        </form>
      </Dialog>

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
