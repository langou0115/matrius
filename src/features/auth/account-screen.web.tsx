import { Link, type Href } from 'expo-router';
import { useState, type FormEvent } from 'react';

import { SettingsPage } from '@/features/settings/settings-page.web';
import { useAuth } from './auth-state.web';

export default function AccountScreen() {
  const auth = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null); setNotice(null);
    try {
      if (auth.user) { await auth.changePassword(password, newPassword); setNotice('密码已更新。'); }
      else await auth.login(username.trim(), password);
      setPassword(''); setNewPassword('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  }
  return <SettingsPage title="账号" description="登录账号，使用为你开放的功能。">
    <section className="settings-section" aria-labelledby="account-heading">
      <h2 id="account-heading">{auth.user ? auth.user.username : '登录'}</h2>
      {auth.status === 'checking' && <p className="settings-footnote" role="status">正在验证账号…</p>}
      {auth.status === 'unavailable' && <button type="button" className="secondary-button" onClick={() => void auth.refresh()}>重新验证</button>}
      {auth.user?.mustChangePassword && <p className="settings-footnote" role="status">请先修改初始密码，再使用账号功能。</p>}
      <form className="account-form" onSubmit={(event) => void submit(event)}>
        {!auth.user && <label className="model-form-field">用户名<input className="text-field" autoComplete="username" required maxLength={64} value={username} onChange={(event) => setUsername(event.target.value)} /></label>}
        <label className="model-form-field">{auth.user ? '当前密码' : '密码'}<input className="text-field" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        {auth.user && <label className="model-form-field">新密码<input className="text-field" type="password" autoComplete="new-password" required minLength={8} maxLength={256} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>}
        <div className="account-actions"><button className="primary-button" type="submit" disabled={busy || auth.status === 'checking'}>{busy ? '正在处理…' : auth.user ? '修改密码' : '登录'}</button>
          {auth.user && <button className="secondary-button" type="button" disabled={busy} onClick={() => {
            setError(null); setNotice(null); setPassword(''); setNewPassword('');
            void auth.logout().catch(() => setError('本机已退出，但服务器会话未能撤销，请稍后重新登录并退出。'));
          }}>退出登录</button>}
        </div>
      </form>
      {(error || auth.error) && <p className="model-form-error" role="alert">{error ?? auth.error}</p>}
      {notice && <p className="settings-footnote" role="status">{notice}</p>}
      {auth.user?.isAdmin && <p className="settings-footnote"><Link href={'/admin' as Href} className="admin-link">打开用户管理</Link></p>}
      <p className="settings-footnote">当前登录用于账号功能权限。聊天记录仍保存在此浏览器，云端数据同步尚未启用。登录状态仅保留在当前标签页。</p>
    </section>
  </SettingsPage>;
}
