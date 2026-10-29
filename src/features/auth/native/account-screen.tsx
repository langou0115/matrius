import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/components/native/button';
import { Dialog } from '@/components/native/dialog';
import { useNativeTheme } from '@/theme/native-theme';
import { Footnote, Section, SettingsPage } from '@/features/settings/native/settings-shell';
import { loadWorkspace } from '@/features/workspace/workspace-repository';
import { useAuth } from '../auth-state';
import { useNetworkTools } from '../network-tools-state';
import { ChangePasswordDialog } from './change-password-dialog';
import { importLocalWorkspace } from './import-local';
import { LoginDialog } from './login-dialog';

function NetworkToolsSection() {
  const { enabled, ready, saving, error, setEnabled } = useNetworkTools();
  const busy = !ready || saving;
  return (
    <>
      <Section title="网络工具">
        <View style={styles.row}>
          <View style={styles.rowCopy}>
            <Text style={styles.rowTitle}>启用网络工具</Text>
            <Text style={styles.rowDescription}>允许助手搜索网页并读取正文，回答时附上来源。关闭后只使用模型已有知识。</Text>
          </View>
          {busy ? <ActivityIndicator /> : (
            <Switch value={enabled} disabled={busy} onValueChange={(value) => { void setEnabled(value); }} />
          )}
        </View>
      </Section>
      {error ? <Footnote error>{error}</Footnote> : null}
    </>
  );
}

export function AccountScreen() {
  const theme = useNativeTheme();
  const auth = useAuth();
  const user = auth.user;
  const [loginOpen, setLoginOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [promptDismissedFor, setPromptDismissedFor] = useState<string | null>(null);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Keyed by user so a count loaded for a previous account never leaks into the next one.
  const [local, setLocal] = useState<{ userId: string; count: number } | null>(null);
  const [importing, setImporting] = useState(false);
  const localCount = user && local?.userId === user.id ? local.count : null;

  // A restored session can arrive already flagged for a password change. Derive the dialog
  // open state instead of setting it in an effect, so a dismissal still sticks.
  const passwordDialogOpen = passwordOpen || Boolean(user?.mustChangePassword && user.id !== promptDismissedFor);

  const syncReady = Boolean(user && !user.mustChangePassword);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The local workspace remains readable while signed in, so the account page can offer to
  // copy it up without touching the cloud workspace currently on screen.
  const userId = user?.id;
  useEffect(() => {
    if (!syncReady || !userId) return;
    let active = true;
    loadWorkspace().then((workspace) => {
      if (active) setLocal({ userId, count: workspace.data.chat.conversations.length });
    }).catch(() => { /* Keep the last known count; a new account simply starts without one. */ });
    return () => { active = false; };
  }, [syncReady, userId]);

  function closePasswordDialog() {
    setPasswordOpen(false);
    setPromptDismissedFor(user?.id ?? null);
  }

  async function logout() {
    setBusy(true);
    setError(null);
    setNotice(null);
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

  async function importLocal() {
    if (importing) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await importLocalWorkspace(auth.request);
      if (userId) setLocal({ userId, count: 0 });
      setNotice(`已导入 ${result.conversations} 个对话、${result.messages} 条消息`
        + `${result.skipped ? `，${result.skipped} 个对话未能导入` : ''}。重新打开应用后可在云端工作区看到。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败，请稍后重试。');
    } finally {
      setImporting(false);
    }
  }

  return (
    <SettingsPage title="账号" subtitle="登录账号、管理密码与查看账号状态。">
      <Section>
        <View style={styles.profile}>
          <View style={[styles.avatar, { backgroundColor: theme.colors.muted, borderRadius: 24 }]}>
            {user
              ? <Text style={[styles.avatarText, { color: theme.colors.foreground }]}>{user.username.slice(0, 1).toUpperCase()}</Text>
              : <Ionicons name="person-outline" size={23} color={theme.colors.mutedForeground} />}
          </View>
          <View style={styles.profileCopy}>
            <Text numberOfLines={1} style={[styles.profileName, { color: theme.colors.foreground }]}>{profileTitle}</Text>
            {user ? (
              <View style={styles.badges}>
                <View style={[styles.badge, { backgroundColor: theme.colors.muted }]}>
                  <Ionicons name="checkmark" size={12} color={theme.colors.foreground} />
                  <Text style={[styles.badgeText, { color: theme.colors.foreground }]}>已登录</Text>
                </View>
                {user.isAdmin ? (
                  <View style={[styles.badge, { backgroundColor: theme.colors.muted }]}>
                    <Ionicons name="shield-checkmark-outline" size={12} color={theme.colors.foreground} />
                    <Text style={[styles.badgeText, { color: theme.colors.foreground }]}>管理员</Text>
                  </View>
                ) : null}
                {user.mustChangePassword ? (
                  <View style={[styles.badge, { backgroundColor: theme.colors.muted }]}>
                    <Ionicons name="key-outline" size={12} color={theme.colors.foreground} />
                    <Text style={[styles.badgeText, { color: theme.colors.foreground }]}>需要修改密码</Text>
                  </View>
                ) : null}
              </View>
            ) : (
              <Text style={[styles.rowDescription, { color: theme.colors.mutedForeground }]}>
                {unavailable ? '暂时无法验证登录状态。' : '登录后可跨设备使用你的对话。'}
              </Text>
            )}
          </View>
          {!user && auth.status === 'anonymous' ? (
            <Button label="登录" variant="primary" onPress={() => setLoginOpen(true)} />
          ) : null}
        </View>
      </Section>

      {checking ? <Footnote>正在向服务器验证当前登录状态…</Footnote> : null}
      {unavailable ? (
        <View style={styles.noticeRow}>
          <Ionicons name="alert-circle-outline" size={16} color={theme.colors.destructive} />
          <Text style={[styles.noticeText, { color: theme.colors.destructive }]}>暂时无法验证登录状态，账号设置已隐藏。</Text>
          <Button label="重新验证" onPress={() => { void auth.refresh(); }} />
        </View>
      ) : null}
      {error || auth.error ? <Footnote error>{error ?? auth.error}</Footnote> : null}
      {notice ? <Footnote>{notice}</Footnote> : null}

      {!user ? (
        <Section title="登录后">
          <View style={styles.row}>
            <Ionicons name="cloud-outline" size={20} color={theme.colors.foreground} />
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>云端对话</Text>
              <Text style={styles.rowDescription}>登录后使用账号的云端对话与设置，本地记录独立保留；模型配置仍使用本机配置。</Text>
            </View>
          </View>
        </Section>
      ) : null}

      {syncReady ? <NetworkToolsSection /> : null}

      {syncReady && localCount ? (
        <Section title="本机数据">
          <View style={styles.row}>
            <Ionicons name="download-outline" size={20} color={theme.colors.foreground} />
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>导入本机对话</Text>
              <Text style={styles.rowDescription}>
                把当前设备上的 {localCount} 个本机对话复制到账号。已有对话会保留并合并，模型配置仍只在本机。
              </Text>
            </View>
            <Button label={importing ? '正在导入…' : '导入'} loading={importing} onPress={() => { void importLocal(); }} />
          </View>
        </Section>
      ) : null}

      {user ? (
        <Section title="账号安全">
          {user.mustChangePassword ? (
            <View style={styles.row}>
              <Ionicons name="key-outline" size={20} color={theme.colors.foreground} />
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>首次登录需要修改密码</Text>
                <Text style={styles.rowDescription}>设置新密码后才能继续使用这个账号。</Text>
              </View>
              <Button label="立即修改" variant="primary" onPress={() => setPasswordOpen(true)} />
            </View>
          ) : null}
          <Pressable accessibilityRole="button" onPress={() => setPasswordOpen(true)}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
            <Ionicons name="key-outline" size={20} color={theme.colors.foreground} />
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>密码</Text>
              <Text style={styles.rowDescription}>定期更换密码可以保护账号安全。</Text>
            </View>
            <Text style={[styles.rowAction, { color: theme.colors.mutedForeground }]}>修改密码</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => setLogoutOpen(true)}
            style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
            <Ionicons name="log-out-outline" size={20} color={theme.colors.foreground} />
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle}>登录状态</Text>
            </View>
            <Text style={[styles.rowAction, { color: theme.colors.mutedForeground }]}>退出登录</Text>
          </Pressable>
        </Section>
      ) : null}

      <Footnote>
        {user
          ? '对话与设置保存在账号的云端工作区；同一账号在其他设备登录后会自动拉取。'
          : '当前使用本地工作区，对话只保存在这台设备上。'}
      </Footnote>

      {loginOpen ? <LoginDialog onClose={() => setLoginOpen(false)} /> : null}
      {passwordDialogOpen && user ? (
        <ChangePasswordDialog onClose={closePasswordDialog}
          onSuccess={() => { setError(null); setNotice('密码已更新。'); }} />
      ) : null}
      <Dialog visible={logoutOpen} title="退出登录？" description="退出后需要重新输入密码才能登录。"
        onClose={() => { if (!busy) setLogoutOpen(false); }}
        footer={
          <View style={styles.footer}>
            <Button label="取消" variant="secondary" disabled={busy} onPress={() => setLogoutOpen(false)} />
            <Button label={busy ? '正在退出…' : '退出登录'} variant="primary" loading={busy} onPress={() => { void logout(); }} />
          </View>
        } />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  profile: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  avatar: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 20, fontWeight: '700' },
  profileCopy: { flex: 1, gap: 4 },
  profileName: { fontSize: 17, fontWeight: '600' },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  badgeText: { fontSize: 11.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  rowCopy: { flex: 1, gap: 3 },
  rowTitle: { fontSize: 14.5, fontWeight: '600' },
  rowDescription: { fontSize: 12.5, lineHeight: 18 },
  rowAction: { fontSize: 13 },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  noticeText: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
});
