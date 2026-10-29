import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/native/button';
import { Dialog } from '@/components/native/dialog';
import { Field } from '@/components/native/field';
import { useNativeTheme } from '@/theme/native-theme';
import { useAuth } from '../auth-state';

export function ChangePasswordDialog({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const theme = useNativeTheme();
  const auth = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    if (newPassword === currentPassword) {
      setError('新密码不能与当前密码相同。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.changePassword(currentPassword, newPassword);
      onSuccess();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '密码修改失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog visible title="修改密码" onClose={busy ? () => {} : onClose}
      footer={
        <View style={styles.footer}>
          <Button label="取消" variant="secondary" onPress={onClose} disabled={busy} />
          <Button label={busy ? '正在更新…' : '更新密码'} variant="primary" loading={busy}
            disabled={!currentPassword || !newPassword || !confirmPassword} onPress={() => { void submit(); }} />
        </View>
      }>
      <Field label="当前密码" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry
        maxLength={256} autoCapitalize="none" autoCorrect={false} textContentType="password" />
      <Field label="新密码" value={newPassword} onChangeText={setNewPassword} secureTextEntry
        maxLength={256} autoCapitalize="none" autoCorrect={false} textContentType="newPassword" />
      <Field label="确认新密码" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry
        maxLength={256} autoCapitalize="none" autoCorrect={false} textContentType="newPassword"
        hint="新密码不能与当前密码相同。" />
      {error ? <Text style={[styles.error, { color: theme.colors.destructive }]}>{error}</Text> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
  error: { fontSize: 13, lineHeight: 19 },
});
