import { Link, type Href } from 'expo-router';
import {
  AlertCircle, Check, ChevronRight, Cloud, KeyRound, LoaderCircle, LogIn, LogOut,
  ShieldCheck, UserRound, type LucideIcon,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { PasswordInput } from '@/components/web/password-input';
import { SettingsPage } from '@/features/settings/settings-page.web';
import { useAuth } from './auth-state.web';
import { LoginDialog } from './login-dialog.web';

const benefits: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: Cloud, title: '跨设备同步', description: '同步上线后，换台设备登录就能带回聊天记录和设置。' },
];

export default function AccountScreen() {
  const auth = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true); setError(null); setNotice(null);
    try {
      await auth.changePassword(currentPassword, newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setNotice('密码已更新。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '密码修改失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setError(null); setNotice(null);
    try {
      await auth.logout();
    } catch {
      setError('本机已退出，但服务器会话未能撤销，请稍后重新登录并退出。');
    }
  }

  const user = auth.user;
  return <SettingsPage title="账号" description="登录账号、管理密码与选择要同步的内容。">
    <section className="settings-section" aria-labelledby="account-profile-heading">
      <div className={`account-profile ${user ? 'is-authenticated' : ''}`}>
        <span className="account-avatar">
          {user ? user.username.slice(0, 1).toUpperCase() : <UserRound size={24} strokeWidth={1.75} aria-hidden="true" />}
        </span>
        <div className="account-profile-copy">
          <h2 id="account-profile-heading">{auth.status === 'checking' ? '正在验证账号…' : user ? user.username : '未登录'}</h2>
          <p>{user ? '账号已登录，登录状态只保留在当前标签页。' : '当前以本地模式使用，数据只保存在此浏览器。'}</p>
          {user && <div className="account-badges">
            <span className="account-badge is-success"><Check size={13} strokeWidth={2} aria-hidden="true" />已登录</span>
            {user.isAdmin && <span className="account-badge"><ShieldCheck size={13} strokeWidth={1.75} aria-hidden="true" />管理员</span>}
            {user.mustChangePassword && <span className="account-badge is-warning"><KeyRound size={13} strokeWidth={1.75} aria-hidden="true" />需要修改密码</span>}
          </div>}
        </div>
        <div className="account-profile-actions">
          {user
            ? <button className="secondary-button" type="button" disabled={busy} onClick={() => void logout()}><LogOut size={16} strokeWidth={1.75} aria-hidden="true" />退出登录</button>
            : <button className="primary-button" type="button" onClick={() => setLoginOpen(true)}><LogIn size={16} strokeWidth={1.75} aria-hidden="true" />登录</button>}
        </div>
      </div>
      {auth.status === 'checking' && <p className="settings-footnote" role="status">正在向服务器验证当前登录状态…</p>}
      {auth.status === 'unavailable' && <div className="account-inline-notice" role="status">
        <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>暂时无法验证登录状态，账号设置已隐藏。</span>
        <button className="secondary-button" type="button" onClick={() => void auth.refresh()}>重新验证</button>
      </div>}
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
      <p className="settings-footnote">登录状态仅保留在当前标签页。同步功能还没上线，登录后数据仍保存在这个浏览器。</p>
    </section>}

    {user && <section className="settings-section" aria-labelledby="password-heading">
      <h2 id="password-heading">修改密码</h2>
      {user.mustChangePassword && <div className="account-callout" role="status">
        <KeyRound size={18} strokeWidth={1.75} aria-hidden="true" />
        <div><strong>首次登录需要修改密码</strong><p>设置新密码后才能继续使用这个账号。</p></div>
      </div>}
      <form className="account-form account-form-card" onSubmit={(event) => void changePassword(event)}>
        <label className="model-form-field">当前密码
          <PasswordInput label="当前密码" autoComplete="current-password" required maxLength={256}
            value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <div className="account-password-grid">
          <label className="model-form-field">新密码
            <PasswordInput label="新密码" autoComplete="new-password" required maxLength={256}
              value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </label>
          <label className="model-form-field">确认新密码
            <PasswordInput label="确认新密码" autoComplete="new-password" required maxLength={256}
              value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </label>
        </div>
        <div className="account-actions">
          <button className="primary-button" type="submit" disabled={busy || !currentPassword || !newPassword || !confirmPassword}>
            {busy && <LoaderCircle className="login-spinner" size={16} strokeWidth={2} aria-hidden="true" />}
            {busy ? '正在更新…' : '更新密码'}
          </button>
        </div>
      </form>
    </section>}

    {user && <section className="settings-section" aria-labelledby="sync-summary-heading">
      <h2 id="sync-summary-heading">数据同步</h2>
      <Link href={'/settings/sync' as Href} className="account-link-row">
        <span className="account-link-icon"><Cloud size={19} strokeWidth={1.75} aria-hidden="true" /></span>
        <span className="account-link-copy">
          <strong>选择要同步的内容</strong>
          <span>聊天记录、个人设置、图片和文件，可以逐项开启或关闭。</span>
        </span>
        <span className="account-link-action">管理<ChevronRight size={15} strokeWidth={1.75} aria-hidden="true" /></span>
      </Link>
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

    {(error || auth.error) && <p className="model-form-error" role="alert">{error ?? auth.error}</p>}
    {notice && <p className="settings-footnote" role="status">{notice}</p>}

    {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
  </SettingsPage>;
}
