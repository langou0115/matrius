import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/native/button';
import { Dialog } from '@/components/native/dialog';
import { Field } from '@/components/native/field';
import type { Account } from '@/core/api/auth-session';
import { useNativeTheme } from '@/theme/native-theme';
import { useAuth } from '../auth-state';

type PendingLogin = { password: string; user: Account };

export function LoginDialog({ onClose }: { onClose: () => void }) {
  const theme = useNativeTheme();
  const auth = useAuth();
  const [step, setStep] = useState<'login' | 'change'>('login');
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function login() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const user = await auth.login(username.trim(), password);
      // A newer login superseded this one; it owns the session now.
      if (!user) return;
      if (user.mustChangePassword) {
        setPending({ password, user });
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

  async function changePassword() {
    if (!pending || busy) return;
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

  /** Leaving before choosing a new password must not keep the temporary session signed in. */
  function dismiss() {
    if (step === 'change') void auth.logout().catch(() => {});
    onClose();
  }

  if (step === 'change') {
    return (
      <Dialog visible title="设置新密码" description="首次登录，请先设置新密码。"
        onClose={busy ? () => {} : dismiss}
        footer={
          <View style={styles.footer}>
            <Button label="取消" variant="secondary" onPress={dismiss} disabled={busy} />
            <Button label={busy ? '正在保存…' : '保存并继续'} variant="primary" loading={busy}
              disabled={!newPassword || !confirmPassword} onPress={() => { void changePassword(); }} />
          </View>
        }>
        <Field label="新密码" value={newPassword} onChangeText={setNewPassword} secureTextEntry maxLength={256}
          autoCapitalize="none" autoCorrect={false} />
        <Field label="确认新密码" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry maxLength={256}
          autoCapitalize="none" autoCorrect={false} hint="新密码不能与初始密码相同。" />
        {error ? <Text style={[styles.error, { color: theme.colors.destructive }]}>{error}</Text> : null}
      </Dialog>
    );
  }

  return (
    <Dialog visible title="登录 Matrius" description="登录后使用账号的云端对话与设置，本机记录独立保留。"
      onClose={busy ? () => {} : dismiss}
      footer={
        <View style={styles.footer}>
          <Button label="取消" variant="secondary" onPress={dismiss} disabled={busy} />
          <Button label={busy ? '正在登录…' : '登录'} variant="primary" loading={busy}
            disabled={!username.trim() || !password} onPress={() => { void login(); }} />
        </View>
      }>
      <Field label="账号" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false}
        maxLength={64} textContentType="username" />
      <Field label="密码" value={password} onChangeText={setPassword} secureTextEntry maxLength={256}
        autoCapitalize="none" autoCorrect={false} textContentType="password" />
      {error || auth.error ? <Text style={[styles.error, { color: theme.colors.destructive }]}>{error ?? auth.error}</Text> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
  error: { fontSize: 13, lineHeight: 19 },
});
