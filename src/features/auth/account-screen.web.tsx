import { Link, type Href } from 'expo-router';
import {
  AlertCircle, Check, ChevronRight, Cloud, KeyRound,
  LoaderCircle, LogIn, LogOut, ShieldCheck,
  UserRound, type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { SettingsPage } from '@/features/settings/settings-page.web';
import { useAuth } from './auth-state.web';
import { ChangePasswordDialog } from './change-password-dialog.web';
import { LoginDialog } from './login-dialog.web';
/** The one benefit login currently promises. */
const benefits: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: Cloud, title: '云端对话', description: '登录后使用账号的云端对话与设置，本地记录独立保留；模型配置仍使用本机配置。' },
];

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

  return <SettingsPage title="账号" description="登录账号、管理密码与查看账号状态。">
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
