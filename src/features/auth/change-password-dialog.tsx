import { AlertCircle, LoaderCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { PasswordInput } from '@/components/web/password-input';
import { useAuth } from './auth-state';

type Props = { onClose: () => void; onSuccess: () => void };

/**
 * Password changes live in their own dialog: the account page stays a read-only summary and
 * sensitive fields never sit open on the page. Errors stay inside the dialog so the
 * page behind it never looks like the change succeeded.
 */
export function ChangePasswordDialog({ onClose, onSuccess }: Props) {
  const auth = useAuth();
  const initial = Boolean(auth.user?.mustChangePassword);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    if (!initial && newPassword === currentPassword) {
      setError('新密码不能与当前密码相同。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(initial ? undefined : currentPassword, newPassword);
      onSuccess();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '密码修改失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={initial ? '设置新密码' : '修改密码'} className="login-dialog" onClose={() => { if (!busy) onClose(); }}>
    {initial && <p className="dialog-description">首次登录，请先设置新密码。</p>}
    <form className="login-form" onSubmit={(event) => void submit(event)}>
      {!initial && <label className="login-field">
        <span className="login-label">当前密码</span>
        <PasswordInput label="当前密码" autoComplete="current-password" required maxLength={256}
          value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
      </label>}
      <label className="login-field">
        <span className="login-label">新密码</span>
        <PasswordInput label="新密码" autoComplete="new-password" required maxLength={256}
          value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
      </label>
      <label className="login-field">
        <span className="login-label">确认新密码</span>
        <PasswordInput label="确认新密码" autoComplete="new-password" required maxLength={256}
          value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
      </label>
      <p className="login-hint">{initial ? '新密码不能与初始密码相同。' : '新密码不能与当前密码相同。'}</p>
      {error && <p className="login-error" role="alert"><AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />{error}</p>}
      <div className="dialog-footer">
        <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" type="submit" disabled={busy || (!initial && !currentPassword) || !newPassword || !confirmPassword}>
          {busy && <LoaderCircle className="login-spinner" size={16} strokeWidth={2} aria-hidden="true" />}
          {busy ? '正在更新…' : initial ? '保存并继续' : '更新密码'}
        </button>
      </div>
    </form>
  </Dialog>;
}
