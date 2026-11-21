import {
  formatWorkHostAddress,
  SSH_AUTH_METHODS,
  validateWorkHostInput,
  type DiscoveredWslDistro,
  type HostConnectionStatus,
  type HostKind,
  type SshAuthMethod,
  type WorkHost,
  type WorkHostInput,
} from '@contract/work-hosts';
import { Eye, EyeOff, Pencil, Plug, Plus, RefreshCw, Search, Server, Terminal, Trash2, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { SelectField } from '@/components/web/select-field';
import { useInstance } from '@/features/instance/instance-state';
import { SettingsPage } from '@/features/settings/settings-page';
import { useIsPreview } from '@/features/workspace/preview-context';
import {
  connectWorkHost,
  createWorkHost,
  deleteWorkHost,
  disconnectWorkHost,
  discoverWslDistros,
  listWorkHosts,
  updateWorkHost,
} from './hosts-api';

type HostFilter = 'all' | HostKind;

type HostFormState = {
  id: string | null;
  revision: number | null;
  kind: HostKind;
  name: string;
  host: string;
  port: string;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath: string;
  secret: string;
  hasSecret: boolean;
  distro: string;
};

const FILTER_OPTIONS: readonly { id: HostFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'ssh', label: 'SSH' },
  { id: 'wsl', label: 'WSL' },
];

function createPreviewHosts(): WorkHost[] {
  const now = Date.now();
  return [
    {
      id: 'mock-host-ssh',
      kind: 'ssh',
      name: '开发服务器',
      host: '192.168.10.24',
      port: 22,
      username: 'dev',
      authMethod: 'key',
      privateKeyPath: '~/.ssh/id_ed25519',
      hasSecret: false,
      distro: '',
      defaultDirectory: '',
      note: '',
      status: 'connected',
      statusMessage: '连接成功（14 ms）',
      lastCheckedAt: now - 120_000,
      revision: 1,
      createdAt: now - 86_400_000,
      updatedAt: now - 120_000,
    },
    {
      id: 'mock-host-wsl',
      kind: 'wsl',
      name: 'Ubuntu-24.04',
      host: '',
      port: 22,
      username: 'matrius',
      authMethod: 'agent',
      privateKeyPath: '',
      hasSecret: false,
      distro: 'Ubuntu-24.04',
      defaultDirectory: '',
      note: '',
      status: 'connected',
      statusMessage: 'WSL 发行版连接正常（22 ms）',
      lastCheckedAt: now - 60_000,
      revision: 1,
      createdAt: now - 43_200_000,
      updatedAt: now - 60_000,
    },
  ];
}

function buildPreviewHost(
  normalized: ReturnType<typeof validateWorkHostInput>,
  options: { idPrefix?: string; hasSecret: boolean; status?: HostConnectionStatus; statusMessage?: string | null; checked?: boolean },
): WorkHost {
  const now = Date.now();
  return {
    id: `${options.idPrefix ?? 'mock-host'}-${now}`,
    ...normalized,
    hasSecret: options.hasSecret,
    status: options.status ?? 'disconnected',
    statusMessage: options.statusMessage ?? null,
    lastCheckedAt: options.checked ? now : null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function patchPreviewHost(host: WorkHost, patch: Partial<WorkHost>, options: { checked?: boolean } = {}): WorkHost {
  const now = Date.now();
  return {
    ...host,
    ...patch,
    ...(options.checked ? { lastCheckedAt: now } : {}),
    revision: host.revision + 1,
    updatedAt: now,
  };
}

function emptyForm(kind: HostKind = 'ssh', preset: Partial<HostFormState> = {}): HostFormState {
  return {
    id: null,
    revision: null,
    kind,
    name: '',
    host: '',
    port: '22',
    username: '',
    authMethod: 'agent',
    privateKeyPath: '',
    secret: '',
    hasSecret: false,
    distro: '',
    ...preset,
  };
}

function formFromHost(host: WorkHost): HostFormState {
  return emptyForm(host.kind, {
    id: host.id,
    revision: host.revision,
    name: host.name,
    host: host.host,
    port: String(host.port || 22),
    username: host.username,
    authMethod: host.authMethod,
    privateKeyPath: host.privateKeyPath,
    hasSecret: host.hasSecret,
    distro: host.distro,
  });
}

function statusLabel(status: HostConnectionStatus): string {
  if (status === 'connected') return '已连接';
  if (status === 'error') return '连接异常';
  return '已断开';
}

function statusClass(status: HostConnectionStatus): string {
  if (status === 'connected') return 'is-active';
  if (status === 'error') return 'is-error';
  return 'is-paused';
}

function formatCheckedAt(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

function authLabel(host: WorkHost): string | null {
  if (host.kind === 'wsl') return null;
  if (host.authMethod === 'key') {
    return host.privateKeyPath ? `私钥 ${host.privateKeyPath}` : '私钥认证';
  }
  if (host.authMethod === 'password') {
    return host.hasSecret ? '密码认证（已保存）' : '密码认证（未填密码）';
  }
  return 'SSH Agent / 默认密钥';
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error && reason.message ? reason.message : '操作失败，请重试。';
}

export default function HostSettingsScreen() {
  const instance = useInstance();
  const preview = useIsPreview();

  const [sourceMode, setSourceMode] = useState<'mock' | 'server'>(() => (preview ? 'mock' : 'server'));
  const [hosts, setHosts] = useState<WorkHost[]>(() => (preview ? createPreviewHosts() : []));
  const [loadedServer, setLoadedServer] = useState(false);
  const [manualReloading, setManualReloading] = useState(false);
  const [filter, setFilter] = useState<HostFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [addingDistro, setAddingDistro] = useState<string | null>(null);
  const [discoveredDistros, setDiscoveredDistros] = useState<DiscoveredWslDistro[]>([]);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const discoverRequestId = useRef(0);
  const [form, setForm] = useState<HostFormState | null>(null);
  const [secretVisible, setSecretVisible] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkHost | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const currentMode = preview ? 'mock' : 'server';
  if (sourceMode !== currentMode) {
    setSourceMode(currentMode);
    setHosts(preview ? createPreviewHosts() : []);
    setLoadedServer(false);
    setDiscoverOpen(false);
    setDiscoveredDistros([]);
    setDiscoverNote(null);
    setDiscoverError(null);
    setFailure(null);
  }

  const canUseServer = !preview && instance.status === 'ready';
  const loading = canUseServer && (!loadedServer || manualReloading);

  const loadHosts = useCallback(async () => {
    if (!canUseServer) return;
    setManualReloading(true);
    try {
      const response = await listWorkHosts(instance.request);
      setHosts(response.items);
      setLoadedServer(true);
      setFailure(null);
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setManualReloading(false);
    }
  }, [canUseServer, instance.request]);

  useEffect(() => {
    if (!canUseServer) return;
    let cancelled = false;
    listWorkHosts(instance.request)
      .then((response) => {
        if (cancelled) return;
        setHosts(response.items);
        setLoadedServer(true);
        setFailure(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLoadedServer(true);
        setFailure(errorMessage(reason));
      });
    return () => { cancelled = true; };
  }, [canUseServer, instance.request]);

  const visibleHosts = useMemo(
    () => (filter === 'all' ? hosts : hosts.filter((item) => item.kind === filter)),
    [hosts, filter],
  );

  function closeForm() {
    setForm(null);
    setSecretVisible(false);
  }

  function updateForm(patch: Partial<HostFormState>) {
    setForm((current) => (current ? { ...current, ...patch } : null));
  }

  function openAdd(kind: HostKind = 'ssh', preset: Partial<HostFormState> = {}) {
    setFormError(null);
    setFeedback(null);
    setFailure(null);
    setSecretVisible(false);
    setForm(emptyForm(kind, preset));
  }

  function openEdit(host: WorkHost) {
    setFormError(null);
    setFeedback(null);
    setFailure(null);
    setSecretVisible(false);
    setForm(formFromHost(host));
  }

  function closeDiscoverDialog() {
    if (addingDistro || saving) return;
    discoverRequestId.current += 1;
    setDiscovering(false);
    setDiscoverOpen(false);
  }

  async function handleDiscoverWsl() {
    const requestId = ++discoverRequestId.current;
    setDiscoverOpen(true);
    setDiscovering(true);
    setDiscoverError(null);
    setDiscoverNote(null);
    setFailure(null);
    setFeedback(null);
    try {
      if (preview) {
        setDiscoveredDistros([
          { name: 'Ubuntu-24.04', state: 'Running', version: 2, isDefault: true },
          { name: 'Debian', state: 'Stopped', version: 2, isDefault: false },
        ]);
        return;
      }
      const result = await discoverWslDistros(instance.request);
      if (discoverRequestId.current !== requestId) return;
      setDiscoveredDistros(result.distros);
      setDiscoverNote(result.message ?? (result.distros.length ? null : '未在本机检测到已安装的 WSL 发行版。'));
    } catch (reason) {
      if (discoverRequestId.current !== requestId) return;
      setDiscoveredDistros([]);
      setDiscoverError(errorMessage(reason));
    } finally {
      if (discoverRequestId.current === requestId) {
        setDiscovering(false);
      }
    }
  }

  async function handleAddDiscoveredWsl(distro: DiscoveredWslDistro) {
    setDiscoverError(null);
    setFailure(null);
    setFeedback(null);
    if (hosts.some((item) => item.kind === 'wsl' && item.distro === distro.name)) return;
    const payload: WorkHostInput = {
      kind: 'wsl',
      name: distro.name,
      distro: distro.name,
    };
    if (preview) {
      const created = buildPreviewHost(validateWorkHostInput(payload), {
        idPrefix: 'mock-wsl',
        hasSecret: false,
        status: distro.state === 'Running' ? 'connected' : 'disconnected',
        statusMessage: distro.state === 'Running' ? 'WSL 发行版运行中' : '已添加，点击连接测试',
        checked: true,
      });
      setHosts((current) => [created, ...current]);
      setFeedback(`已添加 WSL 发行版 ${distro.name}。`);
      return;
    }
    setSaving(true);
    setAddingDistro(distro.name);
    try {
      const created = await createWorkHost(instance.request, payload);
      setHosts((current) => [created, ...current]);
      setFeedback(`已添加 WSL 发行版 ${distro.name}。`);
    } catch (reason) {
      setDiscoverError(errorMessage(reason));
    } finally {
      setAddingDistro(null);
      setSaving(false);
    }
  }

  async function handleSubmitForm(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setFormError(null);
    setFeedback(null);
    setFailure(null);

    const parsedPort = Number(form.port.trim() || '22');
    const rawInput: WorkHostInput = {
      kind: form.kind,
      name: form.name,
      host: form.host,
      port: Number.isFinite(parsedPort) ? parsedPort : NaN,
      username: form.username,
      authMethod: form.authMethod,
      privateKeyPath: form.privateKeyPath,
      ...(form.secret.trim() ? { secret: form.secret.trim() } : {}),
      distro: form.distro,
    };

    let normalized;
    try {
      normalized = validateWorkHostInput(rawInput);
    } catch (reason) {
      setFormError(errorMessage(reason));
      return;
    }

    if (preview) {
      if (form.id) {
        setHosts((current) => current.map((item) => (item.id === form.id ? patchPreviewHost(item, {
          ...normalized,
          hasSecret: normalized.kind === 'ssh' && normalized.authMethod !== 'agent'
            ? (Boolean(form.secret.trim()) || item.hasSecret)
            : false,
        }) : item)));
        setFeedback('主机配置已更新。');
      } else {
        const created = buildPreviewHost(normalized, {
          hasSecret: normalized.kind === 'ssh' && normalized.authMethod !== 'agent' && Boolean(form.secret.trim()),
        });
        setHosts((current) => [created, ...current]);
        setFeedback('已添加主机配置。');
      }
      closeForm();
      return;
    }

    setSaving(true);
    try {
      if (form.id && form.revision !== null) {
        const updated = await updateWorkHost(instance.request, form.id, {
          ...rawInput,
          baseRevision: form.revision,
        });
        setHosts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        setFeedback('主机配置已更新。');
      } else {
        const created = await createWorkHost(instance.request, rawInput);
        setHosts((current) => [created, ...current]);
        setFeedback('已添加主机配置。');
      }
      closeForm();
    } catch (reason) {
      setFormError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function handleConnect(host: WorkHost) {
    setBusyId(host.id);
    setFailure(null);
    setFeedback(null);
    try {
      if (preview) {
        setHosts((current) => current.map((item) => (item.id === host.id ? patchPreviewHost(item, {
          status: 'connected',
          statusMessage: item.kind === 'wsl' ? 'WSL 发行版连接正常（18 ms）' : '连接成功（12 ms）',
        }, { checked: true }) : item)));
        return;
      }
      const updated = await connectWorkHost(instance.request, host.id);
      setHosts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisconnect(host: WorkHost) {
    setBusyId(host.id);
    setFailure(null);
    setFeedback(null);
    try {
      if (preview) {
        setHosts((current) => current.map((item) => (item.id === host.id ? patchPreviewHost(item, {
          status: 'disconnected',
          statusMessage: '已断开连接',
        }) : item)));
        return;
      }
      const updated = await disconnectWorkHost(instance.request, host.id);
      setHosts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setBusyId(target.id);
    setFailure(null);
    setFeedback(null);
    try {
      if (!preview) {
        await deleteWorkHost(instance.request, target.id, target.revision);
      }
      setHosts((current) => current.filter((item) => item.id !== target.id));
      setDeleting(null);
      setFeedback(`已移除主机「${target.name}」。`);
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SettingsPage title="主机">
      <section className="settings-section" aria-labelledby="hosts-heading">
        <div className="hosts-section-header">
          <div className="hosts-heading-row">
            <h2 id="hosts-heading">已配置主机</h2>
            <div className="hosts-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={discovering || saving}
                onClick={() => void handleDiscoverWsl()}
              >
                <Search size={15} strokeWidth={1.75} aria-hidden="true" />
                {discovering ? '正在检测…' : '检测本机 WSL'}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={saving}
                onClick={() => openAdd('ssh')}
              >
                <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                添加主机
              </button>
            </div>
          </div>

          <div className="hosts-filter-row">
            <div className="library-kinds" role="group" aria-label="主机类型筛选">
              {FILTER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`library-kind${filter === option.id ? ' is-active' : ''}`}
                  aria-pressed={filter === option.id}
                  onClick={() => setFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {!preview && (
              <button
                type="button"
                className="icon-button hosts-refresh-btn"
                aria-label="刷新主机列表"
                disabled={loading}
                onClick={() => void loadHosts()}
              >
                <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {failure && <p className="model-form-error" role="alert">{failure}</p>}
        {feedback && <p className="settings-footnote" role="status">{feedback}</p>}

        {loading ? (
          <p className="settings-footnote" role="status">正在读取主机配置…</p>
        ) : visibleHosts.length > 0 ? (
          <div className="host-list" aria-label="主机列表">
            {visibleHosts.map((host) => {
              const busy = busyId === host.id;
              const auth = authLabel(host);
              const checkedTime = formatCheckedAt(host.lastCheckedAt);
              return (
                <article className="host-card" key={host.id}>
                  <div className="host-card-main">
                    <div className="host-card-title-row">
                      <span className="host-kind-icon" aria-hidden="true">
                        {host.kind === 'wsl'
                          ? <Terminal size={16} strokeWidth={1.75} />
                          : <Server size={16} strokeWidth={1.75} />}
                      </span>
                      <strong className="host-card-name">{host.name}</strong>
                      <span className={`task-status-btn host-status-pill ${statusClass(host.status)}`}>
                        <span className="task-status-dot" aria-hidden="true" />
                        {statusLabel(host.status)}
                      </span>
                    </div>

                    <p className="host-card-meta">
                      <span>{host.kind === 'wsl' ? 'WSL' : 'SSH'}</span>
                      <span> · {formatWorkHostAddress(host)}</span>
                      {auth && <span> · {auth}</span>}
                    </p>

                    {host.status === 'error' && (host.statusMessage || checkedTime) && (
                      <p className="host-card-status">
                        {host.statusMessage}
                        {host.statusMessage && checkedTime ? ` · 检测于 ${checkedTime}` : checkedTime ? `检测于 ${checkedTime}` : ''}
                      </p>
                    )}
                  </div>

                  <div className="host-card-actions">
                    {host.status === 'connected' ? (
                      <>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy || saving}
                          onClick={() => void handleConnect(host)}
                        >
                          <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
                          {busy ? '检测中…' : '重测'}
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy || saving}
                          onClick={() => void handleDisconnect(host)}
                        >
                          <Unplug size={14} strokeWidth={1.75} aria-hidden="true" />
                          断开
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy || saving}
                        onClick={() => void handleConnect(host)}
                      >
                        <Plug size={14} strokeWidth={1.75} aria-hidden="true" />
                        {busy ? '连接中…' : '连接测试'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`编辑主机：${host.name}`}
                      disabled={busy || saving}
                      onClick={() => openEdit(host)}
                    >
                      <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger-icon"
                      aria-label={`删除主机：${host.name}`}
                      disabled={busy || saving}
                      onClick={() => setDeleting(host)}
                    >
                      <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="provider-empty-state">
            <span className="provider-empty-icon"><Server size={22} strokeWidth={1.6} aria-hidden="true" /></span>
            <strong>{filter === 'all' ? '还没有已配置的主机' : `还没有 ${filter.toUpperCase()} 主机`}</strong>
            <div className="tasks-placeholder-actions">
              <button type="button" className="primary-button" disabled={saving} onClick={() => openAdd(filter === 'wsl' ? 'wsl' : 'ssh')}>
                <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
                添加主机
              </button>
            </div>
          </div>
        )}
      </section>

      {form && (
        <Dialog
          title={form.id ? '编辑主机' : '添加主机'}
          onClose={() => { if (!saving) closeForm(); }}
          className="model-form-dialog"
        >
          <form className="provider-edit-form" onSubmit={(event) => void handleSubmitForm(event)}>
            <fieldset disabled={saving}>
              {!form.id && (
                <div className="library-kinds host-kind-switch" role="group" aria-label="主机类型">
                  <button
                    type="button"
                    className={`library-kind${form.kind === 'ssh' ? ' is-active' : ''}`}
                    aria-pressed={form.kind === 'ssh'}
                    onClick={() => {
                      setFormError(null);
                      updateForm({ kind: 'ssh' });
                    }}
                  >
                    SSH 主机
                  </button>
                  <button
                    type="button"
                    className={`library-kind${form.kind === 'wsl' ? ' is-active' : ''}`}
                    aria-pressed={form.kind === 'wsl'}
                    onClick={() => {
                      setFormError(null);
                      updateForm({ kind: 'wsl' });
                    }}
                  >
                    WSL 发行版
                  </button>
                </div>
              )}

              <label className="model-form-field">
                主机名称
                <input
                  className="text-field"
                  value={form.name}
                  onChange={(event) => updateForm({ name: event.target.value })}
                  placeholder={form.kind === 'wsl' ? '例如：Ubuntu-24.04' : '例如：生产服务器'}
                  required
                  maxLength={120}
                />
              </label>

              {form.kind === 'ssh' ? (
                <>
                  <div className="model-form-columns">
                    <label className="model-form-field">
                      主机地址
                      <input
                        className="text-field"
                        value={form.host}
                        onChange={(event) => updateForm({ host: event.target.value })}
                        placeholder="192.168.1.10 或 example.com"
                        required
                        autoCapitalize="none"
                        spellCheck={false}
                      />
                    </label>
                    <label className="model-form-field host-port-field">
                      端口
                      <input
                        className="text-field"
                        type="number"
                        min={1}
                        max={65535}
                        step={1}
                        value={form.port}
                        onChange={(event) => updateForm({ port: event.target.value })}
                        required
                      />
                    </label>
                  </div>

                  <label className="model-form-field">
                    用户名
                    <input
                      className="text-field"
                      value={form.username}
                      onChange={(event) => updateForm({ username: event.target.value })}
                      placeholder="例如：root、ubuntu（留空走本机 ssh 配置）"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={120}
                    />
                  </label>

                  <SelectField
                    label="认证方式"
                    value={form.authMethod}
                    options={SSH_AUTH_METHODS}
                    onChange={(value) => {
                      setSecretVisible(false);
                      updateForm({ authMethod: value as SshAuthMethod });
                    }}
                  />

                  {form.authMethod === 'key' && (
                    <label className="model-form-field">
                      私钥路径
                      <input
                        className="text-field"
                        value={form.privateKeyPath}
                        onChange={(event) => updateForm({ privateKeyPath: event.target.value })}
                        placeholder="例如：~/.ssh/id_ed25519"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={500}
                      />
                    </label>
                  )}

                  {form.authMethod === 'password' && (
                    <label className="model-form-field">
                      SSH 密码
                      <div className="host-secret-wrap">
                        <input
                          className="text-field"
                          type={secretVisible ? 'text' : 'password'}
                          value={form.secret}
                          onChange={(event) => updateForm({ secret: event.target.value })}
                          placeholder={form.hasSecret ? '已保存；留空保持不变' : '输入密码'}
                          autoComplete="new-password"
                          autoCapitalize="none"
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="host-secret-toggle"
                          aria-label={secretVisible ? '隐藏密码' : '显示密码'}
                          aria-pressed={secretVisible}
                          onClick={() => setSecretVisible((current) => !current)}
                        >
                          {secretVisible
                            ? <EyeOff size={17} strokeWidth={1.75} aria-hidden="true" />
                            : <Eye size={17} strokeWidth={1.75} aria-hidden="true" />}
                        </button>
                      </div>
                    </label>
                  )}
                </>
              ) : (
                <>
                  <label className="model-form-field">
                    WSL 发行版名称
                    <input
                      className="text-field"
                      value={form.distro}
                      onChange={(event) => updateForm({ distro: event.target.value })}
                      placeholder="例如：Ubuntu-24.04、Debian"
                      required
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={120}
                    />
                  </label>
                  <label className="model-form-field">
                    登录用户（可选）
                    <input
                      className="text-field"
                      value={form.username}
                      onChange={(event) => updateForm({ username: event.target.value })}
                      placeholder="留空使用发行版默认用户"
                      autoCapitalize="none"
                      spellCheck={false}
                      maxLength={120}
                    />
                  </label>
                </>
              )}

              {formError && <p className="model-form-error" role="alert">{formError}</p>}

              <div className="dialog-footer">
                <button type="button" className="secondary-button" onClick={closeForm}>取消</button>
                <button type="submit" className="primary-button">{saving ? '保存中…' : '保存主机'}</button>
              </div>
            </fieldset>
          </form>
        </Dialog>
      )}

      {deleting && (
        <Dialog
          title="删除主机配置？"
          onClose={() => { if (!busyId) setDeleting(null); }}
          className="compact-dialog"
        >
          <p className="dialog-description">
            移除「{deleting.name}」（{formatWorkHostAddress(deleting)}）后，已保存的连接配置与密码将一并删除。
          </p>
          <div className="dialog-footer">
            <button type="button" className="secondary-button" data-autofocus onClick={() => setDeleting(null)}>取消</button>
            <button
              type="button"
              className="danger-button"
              disabled={busyId === deleting.id}
              onClick={() => void handleConfirmDelete()}
            >
              {busyId === deleting.id ? '删除中…' : '删除主机'}
            </button>
          </div>
        </Dialog>
      )}

      {discoverOpen && (
        <Dialog
          title="本机 WSL 发行版"
          onClose={closeDiscoverDialog}
          className="catalog-dialog hosts-discovery-dialog"
        >
          {discoverError && <p className="model-form-error" role="alert">{discoverError}</p>}
          {discovering ? (
            <p className="catalog-status" role="status">正在检测本机 WSL 发行版…</p>
          ) : discoveredDistros.length > 0 ? (
            <>
              <p className="catalog-summary" role="status">
                {discoverNote ?? `共检测到 ${discoveredDistros.length} 个 WSL 发行版`}
              </p>
              <div className="hosts-discovery-list" aria-label="本机 WSL 检测结果">
                {discoveredDistros.map((distro) => {
                  const exists = hosts.some((item) => item.kind === 'wsl' && item.distro === distro.name);
                  const adding = addingDistro === distro.name;
                  return (
                    <div className="hosts-discovery-item" key={distro.name}>
                      <div className="hosts-discovery-copy">
                        <strong>{distro.name}</strong>
                        <span>
                          {distro.state}
                          {distro.version ? ` · WSL ${distro.version}` : ''}
                          {distro.isDefault ? ' · 默认' : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={exists || saving}
                        onClick={() => void handleAddDiscoveredWsl(distro)}
                      >
                        {adding ? '添加中…' : exists ? '已添加' : '添加到主机'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : !discoverError && (
            <p className="catalog-status" role="status">{discoverNote ?? '未在本机检测到已安装的 WSL 发行版。'}</p>
          )}
          <div className="dialog-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={discovering || saving}
              onClick={() => void handleDiscoverWsl()}
            >
              <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
              {discovering ? '检测中…' : '重新检测'}
            </button>
            <button
              type="button"
              className="primary-button"
              data-autofocus
              disabled={Boolean(addingDistro) || saving}
              onClick={closeDiscoverDialog}
            >
              完成
            </button>
          </div>
        </Dialog>
      )}
    </SettingsPage>
  );
}
