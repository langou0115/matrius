import {
  AlertCircle, Ban, CheckCircle2, Copy, Eye, EyeOff, KeyRound, LoaderCircle,
  LogOut, RefreshCw, Search, ShieldCheck, UserPlus, Users, type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { createAdminSession } from '@/core/api/auth-session';
import { copyText } from '@/core/platform/clipboard.web';
import { browserAdminSessionStore } from '@/core/platform/auth-session.web';

type AdminUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  disabledAt: string | null;
  createdAt: string;
};

type Credential = { username: string; password: string; kind: 'created' | 'reset' };

const formatDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
};

const initialOf = (username: string) => username.slice(0, 1).toUpperCase();

function StatCard({ icon: Glyph, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return <div className="admin-stat">
    <span className="admin-stat-icon"><Glyph size={19} strokeWidth={1.75} aria-hidden="true" /></span>
    <div><span>{label}</span><strong>{value}</strong></div>
  </div>;
}

function CredentialPanel({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await copyText(credential.password);
      setCopyStatus('copied');
      window.setTimeout(() => setCopyStatus('idle'), 1800);
    } catch {
      setCopyStatus('failed');
    }
  }
  return <>
    <div className="admin-credential">
      <span className="admin-credential-icon"><KeyRound size={20} strokeWidth={1.75} aria-hidden="true" /></span>
      <div>
        <strong>{credential.username}</strong>
        <p>{credential.kind === 'created' ? '账号已创建。初始密码只显示这一次，请现在交给用户。' : '密码已重置。新密码只显示这一次，用户下次登录后必须修改。'}</p>
      </div>
    </div>
    <div className="admin-password-row">
      <code>{credential.password}</code>
      <button className="secondary-button" type="button" onClick={() => void copy()}>
        {copyStatus === 'copied' ? <CheckCircle2 size={15} strokeWidth={1.75} aria-hidden="true" /> : <Copy size={15} strokeWidth={1.75} aria-hidden="true" />}
        {copyStatus === 'copied' ? '已复制' : copyStatus === 'failed' ? '复制失败' : '复制密码'}
      </button>
    </div>
    <div className="dialog-footer"><button className="primary-button" type="button" onClick={onClose}>完成</button></div>
  </>;
}

export default function AdminScreen() {
  const [session] = useState(() => createAdminSession(browserAdminSessionStore()));
  const { status, user, error: sessionError } = useSyncExternalStore(
    session.subscribe, session.getSnapshot, session.getSnapshot,
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [logoutBusy, setLogoutBusy] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createAdmin, setCreateAdmin] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);

  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void session.refresh();
    return () => session.dispose();
  }, [session]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    session.request<{ items: AdminUser[] }>('/api/admin/users').then((result) => {
      if (active) setUsers(result.items);
    }).catch((reason: unknown) => {
      if (active) setListError(reason instanceof Error ? reason.message : '无法获取用户列表。');
    }).finally(() => { if (active) setListBusy(false); });
    return () => { active = false; };
  }, [session, user, reloadKey]);

  function refreshUsers() {
    setListBusy(true);
    setListError(null);
    setReloadKey((value) => value + 1);
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setLoginBusy(true); setError(null);
    try {
      await session.login(username.trim(), password);
      setPassword('');
      setUsers(null);
      setListBusy(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试。');
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    setLogoutBusy(true); setError(null);
    try {
      await session.logout();
      setUsers(null); setQuery(''); setListBusy(false); setListError(null);
    } catch {
      setError('本机已退出管理，但服务器会话未能撤销，请稍后重试。');
    } finally {
      setLogoutBusy(false);
    }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setCreateBusy(true); setCreateError(null);
    const name = createName.trim();
    try {
      const result = await session.request<{ password: string }>('/api/admin/users', {
        method: 'POST', body: JSON.stringify({ username: name, isAdmin: createAdmin }),
      });
      setCreateOpen(false);
      setCreateName(''); setCreateAdmin(false);
      setCredential({ username: name, password: result.password, kind: 'created' });
      refreshUsers();
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : '创建用户失败，请重试。');
    } finally {
      setCreateBusy(false);
    }
  }

  async function resetPassword() {
    if (!resetTarget) return;
    setActionBusy(true); setActionError(null);
    try {
      const result = await session.request<{ password: string }>(`/api/admin/users/${resetTarget.id}/reset-password`, { method: 'POST' });
      setUsers((current) => current?.map((item) => item.id === resetTarget.id ? { ...item, mustChangePassword: true } : item) ?? null);
      setCredential({ username: resetTarget.username, password: result.password, kind: 'reset' });
      setResetTarget(null);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '重置密码失败，请重试。');
    } finally {
      setActionBusy(false);
    }
  }

  async function toggleDisabled() {
    if (!disableTarget) return;
    setActionBusy(true); setActionError(null);
    const nextDisabled = !disableTarget.disabledAt;
    try {
      const updated = await session.request<AdminUser>(`/api/admin/users/${disableTarget.id}`, {
        method: 'PATCH', body: JSON.stringify({ disabled: nextDisabled }),
      });
      setUsers((current) => current?.map((item) => item.id === updated.id ? updated : item) ?? null);
      setDisableTarget(null);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '操作失败，请重试。');
    } finally {
      setActionBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!users) return [];
    return term ? users.filter((item) => item.username.toLocaleLowerCase().includes(term)) : users;
  }, [query, users]);
  const stats = useMemo(() => ({
    total: users?.length ?? 0,
    admins: users?.filter((item) => item.isAdmin).length ?? 0,
    pending: users?.filter((item) => item.mustChangePassword && !item.disabledAt).length ?? 0,
    disabled: users?.filter((item) => item.disabledAt).length ?? 0,
  }), [users]);

  if (!user) {
    return <main className="admin-main admin-login-main" id="main-content" tabIndex={-1}>
      <div className="admin-login-shell">
        <div className="admin-login-card">
          <div className="admin-brand"><span className="admin-brand-mark"><ShieldCheck size={21} strokeWidth={1.75} aria-hidden="true" /></span>
            <div><strong>Matrius</strong><span>管理控制台</span></div>
          </div>
          <h1>管理员登录</h1>
          {status === 'checking'
            ? <p className="admin-login-status" role="status"><LoaderCircle className="login-spinner" size={16} strokeWidth={2} aria-hidden="true" />正在验证管理员会话…</p>
            : <form className="login-form" onSubmit={(event) => void login(event)}>
              <label className="login-field">
                <span className="login-label">账号</span>
                <span className="login-input-wrap">
                  <Users size={17} strokeWidth={1.75} aria-hidden="true" />
                  <input className="text-field" required maxLength={64} autoComplete="username"
                    value={username} onChange={(event) => setUsername(event.target.value)} />
                </span>
              </label>
              <label className="login-field">
                <span className="login-label">密码</span>
                <span className="login-input-wrap">
                  <KeyRound size={17} strokeWidth={1.75} aria-hidden="true" />
                  <input className="text-field" type={showPassword ? 'text' : 'password'} required maxLength={256}
                    autoComplete="current-password" value={password}
                    onChange={(event) => setPassword(event.target.value)} />
                  <button type="button" className="login-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'}
                    onClick={() => setShowPassword((value) => !value)}>
                    {showPassword ? <EyeOff size={17} strokeWidth={1.75} aria-hidden="true" /> : <Eye size={17} strokeWidth={1.75} aria-hidden="true" />}
                  </button>
                </span>
              </label>
              {(error || sessionError) && <p className="login-error" role="alert"><AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />{error ?? sessionError}</p>}
              <button className="primary-button login-submit" type="submit" disabled={loginBusy || !username.trim() || !password}>
                {loginBusy && <LoaderCircle className="login-spinner" size={17} strokeWidth={2} aria-hidden="true" />}
                {loginBusy ? '正在登录…' : '登录'}
              </button>
            </form>}
          {status === 'unavailable' && <button className="secondary-button admin-login-retry" type="button" onClick={() => void session.refresh()}>重新验证会话</button>}
        </div>
      </div>
    </main>;
  }

  return <main className="admin-main" id="main-content" tabIndex={-1}>
    <header className="admin-topbar">
      <div className="admin-brand"><span className="admin-brand-mark">M</span>
        <div><strong>Matrius</strong><span>管理控制台</span></div>
      </div>
      <div className="admin-topbar-actions">
        <span className="admin-current-user"><span className="admin-avatar is-small">{initialOf(user.username)}</span>{user.username}</span>
        <button className="secondary-button" type="button" disabled={logoutBusy} onClick={() => void logout()}>
          <LogOut size={15} strokeWidth={1.75} aria-hidden="true" />退出管理
        </button>
      </div>
    </header>

    <div className="admin-content">
      <div className="admin-page-heading">
        <div>
          <span className="eyebrow">ADMINISTRATION</span>
          <h1>用户管理</h1>
          <p>创建账号、重置密码与停用用户。初始密码只在操作完成时显示一次。</p>
        </div>
        <div className="admin-heading-actions">
          <button className="secondary-button" type="button" disabled={listBusy} onClick={refreshUsers}>
            <RefreshCw className={listBusy ? 'login-spinner' : ''} size={15} strokeWidth={1.75} aria-hidden="true" />刷新
          </button>
          <button className="primary-button" type="button" onClick={() => { setCreateError(null); setCreateOpen(true); }}>
            <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />创建用户
          </button>
        </div>
      </div>

      <div className="admin-stats">
        <StatCard icon={Users} label="全部用户" value={stats.total} />
        <StatCard icon={ShieldCheck} label="管理员" value={stats.admins} />
        <StatCard icon={KeyRound} label="待改密码" value={stats.pending} />
        <StatCard icon={Ban} label="已停用" value={stats.disabled} />
      </div>

      <section className="admin-panel" aria-labelledby="user-list-heading">
        <header className="admin-panel-header">
          <div><h2 id="user-list-heading">全部用户</h2>
            <p>{users ? (query.trim() ? `找到 ${filtered.length} 个匹配账号` : `共 ${users.length} 个账号`) : '正在加载用户列表…'}</p>
          </div>
          <label className="admin-search">
            <Search size={16} strokeWidth={1.75} aria-hidden="true" />
            <input type="search" placeholder="搜索用户名" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </header>

        {(error || listError) && <div className="admin-alert" role="alert">
          <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{error ?? listError}</span>
          {listError && <button className="secondary-button" type="button" onClick={refreshUsers}>重试</button>}
        </div>}

        {!users && !listError ? <div className="admin-skeleton" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => <div className="admin-skeleton-row" key={row}><span /><span /><span /><span /></div>)}
        </div> : filtered.length === 0 ? <div className="admin-empty">
          <span className="admin-empty-icon"><Users size={22} strokeWidth={1.75} aria-hidden="true" /></span>
          <strong>{query.trim() ? '没有匹配的用户' : '还没有用户'}</strong>
          <p>{query.trim() ? '试试其他用户名，或清空搜索。' : '创建第一个账号，然后把这个页面交给对方保存初始密码。'}</p>
          {!query.trim() && <button className="primary-button" type="button" onClick={() => setCreateOpen(true)}><UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />创建用户</button>}
        </div> : <div className="admin-table" role="table" aria-label="用户列表">
          <div className="admin-table-head" role="row">
            <span role="columnheader">用户</span>
            <span role="columnheader">角色</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">创建时间</span>
            <span role="columnheader" className="admin-actions-heading">操作</span>
          </div>
          {filtered.map((item) => {
            const self = item.id === user.id;
            return <div className={`admin-row ${item.disabledAt ? 'is-disabled' : ''}`} role="row" key={item.id}>
              <div className="admin-user-cell" role="cell">
                <span className="admin-avatar">{initialOf(item.username)}</span>
                <div><strong>{item.username}{self && <span className="admin-you">我</span>}</strong><span>{item.id.slice(0, 8)}…</span></div>
              </div>
              <span role="cell"><span className={`admin-badge ${item.isAdmin ? 'is-admin' : ''}`}>{item.isAdmin ? '管理员' : '成员'}</span></span>
              <span role="cell"><span className={`admin-badge ${item.disabledAt ? 'is-disabled' : item.mustChangePassword ? 'is-warning' : 'is-success'}`}>
                {item.disabledAt ? '已停用' : item.mustChangePassword ? '待改密码' : '正常'}
              </span></span>
              <span className="admin-date" role="cell">{formatDate(item.createdAt)}</span>
              <div className="admin-row-actions" role="cell">
                <button className="icon-button admin-row-action" type="button" aria-label={`重置 ${item.username} 的密码`}
                  onClick={() => { setActionError(null); setResetTarget(item); }}>
                  <KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button className={`icon-button admin-row-action ${item.disabledAt ? '' : 'danger-icon'}`} type="button"
                  aria-label={item.disabledAt ? `启用 ${item.username}` : `停用 ${item.username}`}
                  disabled={self} onClick={() => { setActionError(null); setDisableTarget(item); }}>
                  {item.disabledAt ? <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" /> : <Ban size={16} strokeWidth={1.75} aria-hidden="true" />}
                </button>
              </div>
            </div>;
          })}
        </div>}
      </section>
    </div>

    {createOpen && <Dialog title="创建用户" className="compact-dialog" onClose={() => setCreateOpen(false)}>
      <form className="account-form admin-dialog-form" onSubmit={(event) => void createUser(event)}>
        <label className="model-form-field">用户名
          <input className="text-field" required maxLength={64} autoComplete="off" placeholder="例如：zhang.san"
            value={createName} onChange={(event) => setCreateName(event.target.value)} />
        </label>
        <p className="login-hint">初始密码由服务器生成，格式为「用户名@123」，只显示一次。用户首次登录后必须修改。</p>
        <label className="model-key-toggle">
          <input className="model-checkbox-input" type="checkbox" checked={createAdmin} onChange={(event) => setCreateAdmin(event.target.checked)} />
          <span className="model-checkbox" aria-hidden="true" />
          <span className="model-toggle-copy"><strong>设为管理员</strong><small>管理员可以进入管理控制台并管理其他用户。</small></span>
        </label>
        {createError && <p className="model-form-error" role="alert">{createError}</p>}
        <div className="dialog-footer">
          <button className="secondary-button" type="button" onClick={() => setCreateOpen(false)}>取消</button>
          <button className="primary-button" type="submit" disabled={createBusy || !createName.trim()}>
            {createBusy && <LoaderCircle className="login-spinner" size={15} strokeWidth={2} aria-hidden="true" />}
            {createBusy ? '正在创建…' : '创建用户'}
          </button>
        </div>
      </form>
    </Dialog>}

    {credential && <Dialog title={credential.kind === 'created' ? '账号已创建' : '密码已重置'} className="compact-dialog" onClose={() => setCredential(null)}>
      <CredentialPanel credential={credential} onClose={() => setCredential(null)} />
    </Dialog>}

    {resetTarget && <Dialog title="重置密码" className="compact-dialog" onClose={() => setResetTarget(null)}>
      <p className="dialog-description">将 {resetTarget.username} 的密码重置为初始密码？当前密码会立即失效，对方下次登录后必须修改密码。</p>
      {actionError && <p className="model-form-error" role="alert">{actionError}</p>}
      <div className="dialog-footer">
        <button className="secondary-button" type="button" onClick={() => setResetTarget(null)}>取消</button>
        <button className="primary-button" type="button" disabled={actionBusy} onClick={() => void resetPassword()}>
          {actionBusy && <LoaderCircle className="login-spinner" size={15} strokeWidth={2} aria-hidden="true" />}
          {actionBusy ? '正在重置…' : '重置密码'}
        </button>
      </div>
    </Dialog>}

    {disableTarget && <Dialog title={disableTarget.disabledAt ? '启用用户' : '停用用户'} className="compact-dialog" onClose={() => setDisableTarget(null)}>
      <p className="dialog-description">{disableTarget.disabledAt
        ? `启用后，${disableTarget.username} 可以重新登录。`
        : `停用后，${disableTarget.username} 的现有会话会失效，且无法登录。可以随时再次启用。`}</p>
      {actionError && <p className="model-form-error" role="alert">{actionError}</p>}
      <div className="dialog-footer">
        <button className="secondary-button" type="button" onClick={() => setDisableTarget(null)}>取消</button>
        <button className={disableTarget.disabledAt ? 'primary-button' : 'danger-button'} type="button" disabled={actionBusy}
          onClick={() => void toggleDisabled()}>
          {actionBusy && <LoaderCircle className="login-spinner" size={15} strokeWidth={2} aria-hidden="true" />}
          {actionBusy ? '正在处理…' : disableTarget.disabledAt ? '启用用户' : '停用用户'}
        </button>
      </div>
    </Dialog>}
  </main>;
}
