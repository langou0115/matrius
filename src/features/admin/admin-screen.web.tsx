import { Link, type Href } from 'expo-router';
import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';

import { createAdminSession } from '@/core/api/auth-session';
import { browserAdminSessionStore } from '@/core/platform/auth-session.web';

type CreatedUser = { username: string; password: string };

/** Minimal administration page: the only action is creating a user. The server assigns the
    initial password (`<username>@123`) and forces a change on first login. */
export default function AdminScreen() {
  const [session] = useState(() => createAdminSession(browserAdminSessionStore()));
  const { status, user, error: sessionError } = useSyncExternalStore(
    session.subscribe, session.getSnapshot, session.getSnapshot,
  );
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedUser | null>(null);

  useEffect(() => {
    void session.refresh();
    return () => session.dispose();
  }, [session]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (user) {
        const name = username.trim();
        const result = await session.request<{ password: string }>('/api/admin/users', {
          method: 'POST', body: JSON.stringify({ username: name }),
        });
        setCreated({ username: name, password: result.password });
        setUsername('');
      } else {
        await session.login(username.trim(), password);
        setPassword('');
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return <main className="admin-main" id="main-content" tabIndex={-1}>
    <div className="admin-card">
      <Link href={'/' as Href} className="admin-back">← 返回对话</Link>
      <div className="settings-heading">
        <h1>用户管理</h1>
        <p>创建账号并发放初始密码。</p>
      </div>

      {status === 'checking' && <p className="settings-footnote" role="status">正在验证管理员会话…</p>}

      {status !== 'checking' && !user && <section className="settings-section" aria-labelledby="admin-login-heading">
        <h2 id="admin-login-heading">管理员登录</h2>
        <p className="settings-footnote">管理操作需要独立的管理员会话，与「设置 → 账号」中的普通登录互不影响。</p>
        <form className="account-form" onSubmit={(event) => void submit(event)}>
          <label className="model-form-field">管理员账号
            <input className="text-field" autoComplete="username" required maxLength={64}
              value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label className="model-form-field">密码
            <input className="text-field" type="password" autoComplete="current-password" required maxLength={256}
              value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
          <div className="account-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? '正在登录…' : '登录'}</button>
          </div>
        </form>
        {status === 'unavailable' && <button type="button" className="secondary-button" onClick={() => void session.refresh()}>重新验证</button>}
      </section>}

      {user && <section className="settings-section" aria-labelledby="admin-create-heading">
        <h2 id="admin-create-heading">创建用户</h2>
        <p className="settings-footnote">当前管理员：{user.username}。初始密码由服务器生成，格式为 <code>用户名@123</code>，只显示一次。</p>
        <form className="account-form" onSubmit={(event) => void submit(event)}>
          <label className="model-form-field">用户名
            <input className="text-field" autoComplete="off" required maxLength={64}
              value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <div className="account-actions">
            <button className="primary-button" type="submit" disabled={busy}>{busy ? '正在创建…' : '创建用户'}</button>
          </div>
        </form>
        {created && <div className="admin-credential" role="status">
          <strong>账号已创建</strong>
          <span>用户名：{created.username}</span>
          <span>初始密码：<code>{created.password}</code></span>
          <span className="settings-footnote">请现在保存。用户首次登录后必须修改密码。</span>
        </div>}
      </section>}

      {(error || sessionError) && <p className="model-form-error" role="alert">{error ?? sessionError}</p>}

      {user && <div className="account-actions admin-footer">
        <button className="secondary-button" type="button" disabled={busy} onClick={() => {
          setError(null);
          void session.logout().catch(() => setError('本机已退出，但服务器会话未能撤销，请稍后重新登录并退出。'));
        }}>退出管理</button>
      </div>}
    </div>
  </main>;
}
