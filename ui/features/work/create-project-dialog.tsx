import type { WorkCliProvider } from '@contract/work-cli';
import {
  LOCAL_WORK_HOST_ID,
  WORK_PROJECT_AI_CLI_ITEMS,
  deriveProjectName,
  normalizeProjectCliArgs,
  normalizeProjectProxyUrl,
  serializeWorkProjectCliArgs,
  serializeWorkProjectCliProxies,
  type NormalizedWorkProjectCliArgs,
  type NormalizedWorkProjectCliProxies,
  type WorkProject,
} from '@contract/work-projects';
import type { WorkHost } from '@contract/work-hosts';
import {
  ChevronRight,
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
import { TerminalPresetIcon } from './terminal-preset-icon';
import { createPreviewWorkHosts, createWorkProject, updateWorkProject } from './work-api';
import { WorkErrorDialog } from './work-error-dialog';
import {
  setWorkProjectAiGroupExpanded,
  toggleWorkProjectAiGroupExpanded,
  useWorkState,
} from './work-state';

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

const CLI_ARGS_PLACEHOLDERS: Record<WorkCliProvider, string> = {
  claude: '例如：--dangerously-skip-permissions（留空按默认启动）',
  codex: '例如：--dangerously-bypass-approvals-and-sandbox（留空按默认启动）',
  antigravity: '例如：命令行启动参数（留空按默认启动）',
};

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
  const [hostId, setHostId] = useState<string>(() => project?.hostId ?? defaultHostSelection(seedHosts));
  const [directory, setDirectory] = useState(() => project?.directory ?? '');
  const [cliProxies, setCliProxies] = useState<Record<WorkCliProvider, string>>(() => ({
    codex: project?.cliProxies?.codex ?? '',
    antigravity: project?.cliProxies?.antigravity ?? '',
    claude: project?.cliProxies?.claude ?? '',
  }));
  const [cliArgs, setCliArgs] = useState<Record<WorkCliProvider, string>>(() => ({
    codex: project?.cliArgs?.codex ?? '',
    antigravity: project?.cliArgs?.antigravity ?? '',
    claude: project?.cliArgs?.claude ?? '',
  }));
  const [aiConfigExpanded, setAiConfigExpanded] = useState(() => Boolean(project));
  const { projectAiExpandedGroups: expandedCliGroups } = useWorkState();
  const [browseDir, setBrowseDir] = useState(() => project?.directory ?? '');
  const [browsing, setBrowsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configuredAiCount = WORK_PROJECT_AI_CLI_ITEMS.reduce(
    (count, item) => count + (cliProxies[item.id].trim() ? 1 : 0) + (cliArgs[item.id].trim() ? 1 : 0),
    0,
  );

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
    const trimmedDir = project ? project.directory : directory.trim();
    if (!trimmedDir) {
      setError('请先选择项目目录。');
      return;
    }
    const normalizedProxies: NormalizedWorkProjectCliProxies = {
      codex: '',
      antigravity: '',
      claude: '',
    };
    const normalizedArgs: NormalizedWorkProjectCliArgs = {
      codex: '',
      antigravity: '',
      claude: '',
    };
    for (const item of WORK_PROJECT_AI_CLI_ITEMS) {
      try {
        normalizedProxies[item.id] = normalizeProjectProxyUrl(cliProxies[item.id], item.label);
        normalizedArgs[item.id] = normalizeProjectCliArgs(cliArgs[item.id], item.label);
      } catch (reason) {
        setAiConfigExpanded(true);
        setWorkProjectAiGroupExpanded(item.id, true);
        setError(reason instanceof Error && reason.message ? reason.message : 'AI 配置不合法。');
        return;
      }
    }
    const serializedProxies = serializeWorkProjectCliProxies(normalizedProxies);
    const serializedArgs = serializeWorkProjectCliArgs(normalizedArgs);

    if (preview) {
      const now = Date.now();
      if (project) {
        onSaved({
          ...project,
          ...(serializedProxies ? { cliProxies: serializedProxies } : { cliProxies: undefined }),
          ...(serializedArgs ? { cliArgs: serializedArgs } : { cliArgs: undefined }),
          revision: project.revision + 1,
          updatedAt: now,
        });
      } else {
        onSaved({
          id: `mock-project-${now}`,
          name: deriveProjectName(trimmedDir),
          hostId,
          directory: trimmedDir,
          ...(serializedProxies ? { cliProxies: serializedProxies } : {}),
          ...(serializedArgs ? { cliArgs: serializedArgs } : {}),
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
            cliProxies: normalizedProxies,
            cliArgs: normalizedArgs,
            baseRevision: project.revision,
          })
        : await createWorkProject(instance.request, {
            hostId,
            directory: trimmedDir,
            ...(serializedProxies ? { cliProxies: serializedProxies } : {}),
            ...(serializedArgs ? { cliArgs: serializedArgs } : {}),
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
          <fieldset className="work-project-form-body" disabled={saving}>
            {editing && project && (
              <label className="model-form-field">
                项目名称
                <input
                  className="text-field"
                  value={project.name}
                  readOnly
                  disabled
                  maxLength={120}
                />
              </label>
            )}

            <div className="work-field-block">
              <div className="work-field-header">
                <span className="work-field-title">主机</span>
                {!editing && (
                  <button
                    type="button"
                    className="work-settings-link"
                    onClick={openHostSettings}
                  >
                    主机设置
                  </button>
                )}
              </div>
              <SelectField
                label="主机"
                hideLabel
                fixedPopover
                value={editing && project ? project.hostId : hostId}
                options={hostOptions}
                disabled={editing}
                onChange={(nextHostId) => {
                  if (editing) return;
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
                className={`work-dir-picker${(editing && project ? project.directory : directory) ? ' has-value' : ''}`}
                aria-label={editing ? '项目目录（创建后不可修改）' : '选择项目目录'}
                disabled={editing}
                onClick={() => {
                  if (editing) return;
                  setError(null);
                  setBrowsing(true);
                }}
              >
                <span className="work-dir-picker-icon" aria-hidden="true">
                  <FolderOpen size={15} strokeWidth={1.75} />
                </span>
                <span className="work-dir-picker-text">
                  {(editing && project ? project.directory : directory) || '选择项目目录'}
                </span>
              </button>
            </div>

            <div className="work-proxy-section">
              <button
                type="button"
                className="work-proxy-toggle"
                aria-expanded={aiConfigExpanded}
                aria-controls="work-project-proxy-fields"
                onClick={() => setAiConfigExpanded((open) => !open)}
              >
                <span className="work-field-title">AI 配置</span>
                <span className="work-proxy-toggle-meta">
                  {configuredAiCount > 0 && <span>已配置 {configuredAiCount} 项</span>}
                  <ChevronRight size={15} strokeWidth={1.75} className="work-proxy-chevron" aria-hidden="true" />
                </span>
              </button>
              {aiConfigExpanded && (
                <div id="work-project-proxy-fields" className="work-proxy-fields">
                  {WORK_PROJECT_AI_CLI_ITEMS.map((item) => {
                    const proxyInputId = `work-project-proxy-${item.id}`;
                    const argsInputId = `work-project-args-${item.id}`;
                    const groupPanelId = `work-project-ai-group-${item.id}`;
                    const groupExpanded = Boolean(expandedCliGroups[item.id]);
                    const groupConfiguredCount =
                      (cliProxies[item.id].trim() ? 1 : 0) + (cliArgs[item.id].trim() ? 1 : 0);
                    return (
                      <div key={item.id} className="work-ai-cli-group" data-cli-provider={item.id}>
                        <button
                          type="button"
                          className="work-ai-cli-group-toggle"
                          aria-expanded={groupExpanded}
                          aria-controls={groupPanelId}
                          onClick={() => toggleWorkProjectAiGroupExpanded(item.id)}
                        >
                          <span className="work-ai-cli-group-header">
                            <TerminalPresetIcon preset={item.id} size={14} />
                            <span>{item.label}</span>
                          </span>
                          <span className="work-proxy-toggle-meta">
                            {groupConfiguredCount > 0 && <span>已配置 {groupConfiguredCount} 项</span>}
                            <ChevronRight size={14} strokeWidth={1.75} className="work-proxy-chevron" aria-hidden="true" />
                          </span>
                        </button>
                        {groupExpanded && (
                          <div id={groupPanelId} className="work-ai-cli-group-fields">
                            <div className="work-proxy-cli-field">
                              <label className="work-proxy-cli-label" htmlFor={proxyInputId}>
                                网络代理
                              </label>
                              <input
                                id={proxyInputId}
                                className="text-field work-proxy-input"
                                value={cliProxies[item.id]}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setCliProxies((current) => ({ ...current, [item.id]: value }));
                                }}
                                placeholder="例如：http://127.0.0.1:7890（留空不上代理）"
                                autoCapitalize="none"
                                spellCheck={false}
                                maxLength={500}
                              />
                            </div>
                            <div className="work-proxy-cli-field">
                              <label className="work-proxy-cli-label" htmlFor={argsInputId}>
                                启动参数
                              </label>
                              <input
                                id={argsInputId}
                                className="text-field work-proxy-input"
                                value={cliArgs[item.id]}
                                onChange={(event) => {
                                  const value = event.target.value;
                                  setCliArgs((current) => ({ ...current, [item.id]: value }));
                                }}
                                placeholder={CLI_ARGS_PLACEHOLDERS[item.id]}
                                autoCapitalize="none"
                                spellCheck={false}
                                maxLength={500}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </fieldset>

          <div className="dialog-footer">
            <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving}>
              {saving
                ? (editing ? '保存中…' : '创建中…')
                : (editing ? '保存' : '创建项目')}
            </button>
          </div>
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

      {!editing && browsing && (
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
