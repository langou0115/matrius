import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { BrandMark } from '@/components/web/brand-mark';
import { ApiError } from '@/core/api/instance-client';

export function AuthUnlockScreen({ onUnlock }: { onUnlock: (secret: string) => Promise<void> }) {
  const [secret, setSecret] = useState('');
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = secret.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onUnlock(trimmed);
      setSecret('');
    } catch (reason) {
      if (reason instanceof ApiError) {
        setError(reason.message);
      } else if (reason instanceof Error && reason.message) {
        setError(reason.message);
      } else {
        setError('解锁失败，请重试。');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-unlock-screen" aria-labelledby="auth-unlock-title">
      <form className="auth-unlock-card" onSubmit={(event) => void submit(event)}>
        <div className="auth-unlock-brand">
          <BrandMark size={40} />
          <h1 id="auth-unlock-title">Matrius</h1>
        </div>
        <p className="auth-unlock-description">请输入访问密钥（AUTH_SECRET）以进入你的工作区。</p>
        <label className="auth-unlock-field">
          <span className="sr-only">访问密钥</span>
          <div className="auth-unlock-input-wrap">
            <LockKeyhole className="auth-unlock-icon" size={17} strokeWidth={1.75} aria-hidden="true" />
            <input
              type={visible ? 'text' : 'password'}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="输入访问密钥"
              autoFocus
              autoComplete="current-password"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              required
            />
            <button
              type="button"
              className="auth-unlock-toggle"
              aria-label={visible ? '隐藏访问密钥' : '显示访问密钥'}
              onClick={() => setVisible((current) => !current)}
            >
              {visible
                ? <EyeOff size={17} strokeWidth={1.75} aria-hidden="true" />
                : <Eye size={17} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </div>
        </label>
        {error && <p className="auth-unlock-error" role="alert">{error}</p>}
        <button
          type="submit"
          className="primary-button auth-unlock-submit"
          disabled={submitting || !secret.trim()}
        >
          {submitting ? '正在验证…' : '解锁进入'}
        </button>
      </form>
    </main>
  );
}
