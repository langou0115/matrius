import { AlertCircle, LoaderCircle, ShieldCheck, UserRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { PasswordInput } from '@/components/web/password-input';
import type { Account } from '@/core/api/auth-session';
import { useAuth } from './auth-state.web';

type Props = { onClose: () => void };

type PendingLogin = { username: string; password: string; user: Account };

/**
 * Login lives in a dialog so the sidebar can offer it without leaving the conversation.
 * When the server marks an account as `mustChangePassword`, the same dialog continues to
 * the password step instead of closing and leaving the account half-usable. Closing that
 * step before saving logs the temporary session out, so the account stays signed out.
 */
export function LoginDialog({ onClose }: Props) {
  const auth = useAuth();
  const [step, setStep] = useState<'login' | 'change'>('login');
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await auth.login(username.trim(), password);
      // A newer login superseded this one; it owns the session now.
      if (!user) return;
      if (user.mustChangePassword) {
        setPending({ username: username.trim(), password, user });
        setStep('change');
        return;
      }
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (!pending) return;
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(pending.password, newPassword);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '密码修改失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  // Closing before choosing a new password must not leave the account signed in.
  // logout() clears the local session synchronously, so the dialog can close at once.
  function dismiss() {
    if (step === 'change') void auth.logout().catch(() => {});
    onClose();
  }

  if (step === 'change') {
    return <Dialog title="设置新密码" className="login-dialog" onClose={dismiss}>
      <div className="login-note" role="status">
        <ShieldCheck size={18} strokeWidth={1.75} aria-hidden="true" />
        <p>首次登录，请先设置新密码。</p>
      </div>
      <form className="login-form" onSubmit={(event) => void changePassword(event)}>
        <label className="login-field">
          <span className="login-label">新密码</span>
          <PasswordInput label="新密码" autoFocus required maxLength={256}
            autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        <label className="login-field">
          <span className="login-label">确认新密码</span>
          <PasswordInput label="确认新密码" required maxLength={256}
            autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
        <p className="login-hint">新密码不能与初始密码相同。</p>
        {error && <p className="login-error" role="alert"><AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />{error}</p>}
        <button className="primary-button login-submit" type="submit" disabled={busy || !newPassword || !confirmPassword}>
          {busy && <LoaderCircle className="login-spinner" size={17} strokeWidth={2} aria-hidden="true" />}
          {busy ? '正在保存…' : '保存并继续'}
        </button>
      </form>
    </Dialog>;
  }

  return <Dialog title="登录 Matrius" className="login-dialog" onClose={dismiss}>
    <form className="login-form" onSubmit={(event) => void login(event)}>
      <label className="login-field">
        <span className="login-label">账号</span>
        <span className="login-input-wrap">
          <UserRound size={17} strokeWidth={1.75} aria-hidden="true" />
          <input className="text-field" required maxLength={64} autoComplete="username"
            value={username} onChange={(event) => setUsername(event.target.value)} />
        </span>
      </label>
      <label className="login-field">
        <span className="login-label">密码</span>
        <PasswordInput label="密码" required maxLength={256}
          autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      {(error || auth.error) && <p className="login-error" role="alert"><AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />{error ?? auth.error}</p>}
      <button className="primary-button login-submit" type="submit" disabled={busy || !username.trim() || !password}>
        {busy && <LoaderCircle className="login-spinner" size={17} strokeWidth={2} aria-hidden="true" />}
        {busy ? '正在登录…' : '登录'}
      </button>
    </form>
  </Dialog>;
}
