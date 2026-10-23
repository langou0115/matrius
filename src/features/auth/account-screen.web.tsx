import { Link, type Href } from 'expo-router';
import {
  AlertCircle, Bookmark, Check, ChevronDown, ChevronRight, Cloud, Eye, Globe2, KeyRound,
  LoaderCircle, LogIn, LogOut, MessageSquare, Palette, RefreshCw, ShieldCheck,
  UserRound, type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { SettingsPage } from '@/features/settings/settings-page.web';
import { useAccountSync } from './account-sync-state.web';
import { useAuth } from './auth-state.web';
import { ChangePasswordDialog } from './change-password-dialog.web';
import { LoginDialog } from './login-dialog.web';
import { useNetworkTools } from './network-tools-state.web';
import {
  defaultSyncPreferences, loadSyncPreferences, saveSyncPreferences, syncCategories,
  type SyncCategoryId, type SyncPreferences,
} from './sync-preferences.web';

/** The one benefit login currently promises. */
const benefits: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: Cloud, title: '跨设备同步', description: '换台设备登录同一个账号，就能带回聊天记录和设置。' },
];

const categoryIcons: Record<SyncCategoryId, LucideIcon> = {
  conversations: MessageSquare,
  reading: Eye,
  personalization: Bookmark,
  appearance: Palette,
};

function formatSyncTime(timestamp: number | null): string {
  if (!timestamp) return '尚未同步';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '尚未同步';
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `今天 ${clock}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${clock}`;
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clock}`;
}

function SyncSection({ userId }: { userId: string }) {
  const sync = useAccountSync();
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState<SyncPreferences | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const latest = useRef<SyncPreferences | null>(null);
  const queue = useRef(Promise.resolve());

  useEffect(() => {
    let active = true;
    loadSyncPreferences(userId).then((loaded) => {
      if (!active) return;
      latest.current = loaded;
      setPreferences(loaded);
    }).catch(() => {
      if (!active) return;
      const fallback = defaultSyncPreferences();
      latest.current = fallback;
      setPreferences(fallback);
      setPreferenceError('无法读取同步设置，已恢复为全部开启。');
    });
    return () => { active = false; };
  }, [userId]);

  function toggle(id: SyncCategoryId) {
    if (!latest.current) return;
    const next = { ...latest.current, [id]: !latest.current[id] };
    latest.current = next;
    setPreferences(next);
    setPreferenceError(null);
    queue.current = queue.current
      .then(() => saveSyncPreferences(userId, next))
      .catch(() => setPreferenceError('同步设置未能保存，请重试。'));
  }

  const syncing = sync.phase === 'syncing';
  const lastSync = formatSyncTime(sync.lastSyncedAt);
  const summary = syncing ? '正在同步…' : sync.error ? '同步失败' : sync.lastSyncedAt ? `上次同步：${lastSync}` : lastSync;

  return <section className="settings-section" aria-labelledby="sync-heading">
    <h2 id="sync-heading">数据同步</h2>
    <div className="account-sync">
      <button className="account-sync-toggle" type="button" aria-expanded={open} aria-controls="account-sync-panel"
        onClick={() => setOpen((current) => !current)}>
        <span className="account-sync-toggle-icon"><Cloud size={19} strokeWidth={1.75} aria-hidden="true" /></span>
        <span className="account-sync-toggle-copy">
          <strong>同步到账号</strong>
          <span>{summary}</span>
        </span>
        <ChevronDown className="account-sync-chevron" size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && <div className="account-sync-panel" id="account-sync-panel">
        {preferences
          ? <div className="account-sync-options">
            {syncCategories.map((category) => {
              const Glyph = categoryIcons[category.id];
              return <label className="account-sync-option" key={category.id}>
                <span className="account-sync-option-icon"><Glyph size={18} strokeWidth={1.75} aria-hidden="true" /></span>
                <span className="account-sync-option-copy">
                  <strong>{category.title}</strong>
                  <span>{category.description}</span>
                </span>
                <input className="model-checkbox-input" type="checkbox" checked={preferences[category.id]}
                  onChange={() => toggle(category.id)} />
                <span className="model-checkbox" aria-hidden="true" />
              </label>;
            })}
          </div>
          : <p className="account-sync-loading" role="status">正在读取同步设置…</p>}
        <div className="account-sync-footer">
          <span className={`account-sync-status ${sync.error || preferenceError ? 'is-error' : ''}`} role="status">
            {syncing && <LoaderCircle className="login-spinner" size={14} strokeWidth={2} aria-hidden="true" />}
            {!syncing && !sync.error && !preferenceError && sync.phase === 'done'
              && <Check size={14} strokeWidth={2} aria-hidden="true" />}
            <span>{sync.error ?? preferenceError ?? summary}</span>
          </span>
          <button className="primary-button account-sync-button" type="button" disabled={syncing}
            onClick={sync.syncNow}>
            {syncing
              ? <LoaderCircle className="login-spinner" size={16} strokeWidth={2} aria-hidden="true" />
              : <RefreshCw size={16} strokeWidth={1.75} aria-hidden="true" />}
            {syncing ? '正在同步' : '同步'}
          </button>
        </div>
      </div>}
    </div>
  </section>;
}

function NetworkToolsSection() {
  const { enabled, ready, saving, error, setEnabled } = useNetworkTools();
  const busy = !ready || saving;
  return <section className="settings-section" aria-labelledby="network-tools-heading">
    <h2 id="network-tools-heading">网络工具</h2>
    <div className="account-list">
      <label className="account-row account-toggle-row">
        <span className="account-row-icon"><Globe2 size={19} strokeWidth={1.75} aria-hidden="true" /></span>
        <span className="account-row-copy">
          <strong>启用网络工具</strong>
          <span className="account-row-description">允许助手搜索网页并读取正文，回答时附上来源。关闭后只使用模型已有知识。</span>
        </span>
        {busy && <LoaderCircle className="login-spinner account-row-spinner" size={16} strokeWidth={2} aria-hidden="true" />}
        <input className="model-checkbox-input" type="checkbox" checked={enabled} disabled={busy}
          onChange={(event) => void setEnabled(event.target.checked)} />
        <span className="account-switch" aria-hidden="true" />
      </label>
    </div>
    {error && <p className="account-message is-error" role="alert">
      <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{error}</span>
    </p>}
  </section>;
}

export default function AccountScreen() {
  const auth = useAuth();
  const user = auth.user;
  const [loginOpen, setLoginOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [promptDismissedFor, setPromptDismissedFor] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A restored session can arrive already flagged for a password change. Derive the dialog
  // open state instead of setting it in an effect, so a dismissal still sticks.
  const passwordDialogOpen = passwordOpen || Boolean(user?.mustChangePassword && user.id !== promptDismissedFor);
  function closePasswordDialog() {
    setPasswordOpen(false);
    setPromptDismissedFor(user?.id ?? null);
  }

  // The success note is a transient receipt for the password dialog, not page content.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function logout() {
    setBusy(true); setError(null); setNotice(null);
    try {
      await auth.logout();
    } catch {
      setError('本机已退出，但服务器会话未能撤销，请稍后重新登录并退出。');
    } finally {
      setBusy(false);
      setLogoutOpen(false);
    }
  }

  const checking = auth.status === 'checking';
  const unavailable = auth.status === 'unavailable';
  const profileTitle = checking ? '正在验证账号…' : unavailable ? '账号状态未知' : user ? user.username : '未登录';
  const syncReady = Boolean(user && !user.mustChangePassword);

  return <SettingsPage title="账号" description="登录账号、管理密码与选择要同步的内容。">
    <section className="settings-section" aria-labelledby="account-profile-heading">
      <div className={`account-profile ${user ? 'is-authenticated' : ''}`}>
        <span className="account-avatar" aria-hidden="true">
          {user ? user.username.slice(0, 1).toUpperCase() : <UserRound size={24} strokeWidth={1.75} />}
        </span>
        <div className="account-profile-copy">
          <h2 id="account-profile-heading">{profileTitle}</h2>
          {user && <div className="account-badges">
            <span className="account-badge is-success"><Check size={13} strokeWidth={2} aria-hidden="true" />已登录</span>
            {user.isAdmin && <span className="account-badge"><ShieldCheck size={13} strokeWidth={1.75} aria-hidden="true" />管理员</span>}
            {user.mustChangePassword && <span className="account-badge is-warning"><KeyRound size={13} strokeWidth={1.75} aria-hidden="true" />需要修改密码</span>}
          </div>}
        </div>
        {!user && auth.status === 'anonymous' && <div className="account-profile-actions">
          <button className="primary-button" type="button" onClick={() => setLoginOpen(true)}><LogIn size={16} strokeWidth={1.75} aria-hidden="true" />登录</button>
        </div>}
      </div>

      {checking && <p className="settings-footnote" role="status">正在向服务器验证当前登录状态…</p>}
      {unavailable && <div className="account-inline-notice" role="status">
        <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>暂时无法验证登录状态，账号设置已隐藏。</span>
        <button className="secondary-button" type="button" onClick={() => void auth.refresh()}>重新验证</button>
      </div>}
      {(error || auth.error) && <p className="account-message is-error" role="alert">
        <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{error ?? auth.error}</span>
      </p>}
      {notice && <p className="account-message is-success" role="status">
        <Check size={16} strokeWidth={2} aria-hidden="true" />
        <span>{notice}</span>
      </p>}
    </section>

    {!user && <section className="settings-section" aria-labelledby="login-benefits-heading">
      <h2 id="login-benefits-heading">登录后</h2>
      <div className="account-benefits">
        {benefits.map(({ icon: Glyph, title, description }) => <div className="account-benefit" key={title}>
          <span className="account-benefit-icon"><Glyph size={19} strokeWidth={1.75} aria-hidden="true" /></span>
          <strong>{title}</strong>
          <p>{description}</p>
        </div>)}
      </div>
    </section>}

    {user && syncReady && <SyncSection userId={user.id} />}

    {user && syncReady && <NetworkToolsSection />}

    {user?.isAdmin && <section className="settings-section" aria-labelledby="admin-entry-heading">
      <h2 id="admin-entry-heading">管理</h2>
      <Link href={'/admin' as Href} className="account-link-row">
        <span className="account-link-icon"><ShieldCheck size={19} strokeWidth={1.75} aria-hidden="true" /></span>
        <span className="account-link-copy">
          <strong>管理控制台</strong>
          <span>创建用户、重置密码与停用账号。</span>
        </span>
        <span className="account-link-action">打开<ChevronRight size={15} strokeWidth={1.75} aria-hidden="true" /></span>
      </Link>
    </section>}

    {user && <section className="settings-section" aria-labelledby="security-heading">
      <h2 id="security-heading">账号安全</h2>
      {user.mustChangePassword && <div className="account-callout" role="status">
        <KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />
        <div><strong>首次登录需要修改密码</strong><p>设置新密码后才能继续使用这个账号。</p></div>
        <button className="primary-button" type="button" onClick={() => setPasswordOpen(true)}>立即修改</button>
      </div>}
      <div className="account-list">
        <div className="account-row">
          <span className="account-row-icon"><KeyRound size={19} strokeWidth={1.75} aria-hidden="true" /></span>
          <span className="account-row-copy">
            <strong>密码</strong>
          </span>
          <button className="secondary-button account-row-action" type="button" onClick={() => setPasswordOpen(true)}>修改密码</button>
        </div>
        <div className="account-row">
          <span className="account-row-icon"><LogOut size={19} strokeWidth={1.75} aria-hidden="true" /></span>
          <span className="account-row-copy">
            <strong>登录状态</strong>
          </span>
          <button className="secondary-button account-row-action" type="button" disabled={busy} onClick={() => setLogoutOpen(true)}>退出登录</button>
        </div>
      </div>
    </section>}

    {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    {passwordDialogOpen && user && <ChangePasswordDialog
      onClose={closePasswordDialog}
      onSuccess={() => { setError(null); setNotice('密码已更新。'); }} />}
    {logoutOpen && <Dialog title="退出登录？" className="compact-dialog" onClose={() => { if (!busy) setLogoutOpen(false); }}>
      <p className="dialog-description">退出后需要重新输入密码才能登录。</p>
      <div className="dialog-footer">
        <button className="secondary-button" type="button" disabled={busy} onClick={() => setLogoutOpen(false)}>取消</button>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void logout()}>
          {busy && <LoaderCircle className="login-spinner" size={16} strokeWidth={2} aria-hidden="true" />}
          {busy ? '正在退出…' : '退出登录'}
        </button>
      </div>
    </Dialog>}
  </SettingsPage>;
}
