import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/features/auth/auth-state';
import { useNativeTheme } from '@/theme/native-theme';
import { Card, Footnote, Section, SettingsPage } from './settings-shell';

export function AboutScreen() {
  const theme = useNativeTheme();
  const { status } = useAuth();
  const signedIn = status === 'authenticated';
  const mode = signedIn ? '云端账号' : status === 'checking' ? '正在验证' : status === 'anonymous' ? '本地模式' : '状态未知';
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <SettingsPage title="关于 Matrius" subtitle="应用信息与本地数据说明。">
      <Section title="关于">
        <Card>
          <View style={styles.identity}>
            <View style={[styles.logo, { backgroundColor: theme.colors.primary, borderRadius: Math.min(theme.radius + 4, 16) }]}>
              <Ionicons name="sparkles" size={22} color={theme.colors.primaryForeground} />
            </View>
            <View style={styles.identityCopy}>
              <Text style={[styles.name, { color: theme.colors.foreground }]}>Matrius</Text>
              <Text style={[styles.tagline, { color: theme.colors.mutedForeground }]}>一个安静、自由的 AI 对话空间。</Text>
            </View>
            <Text style={[styles.version, { color: theme.colors.mutedForeground }]}>v{version}</Text>
          </View>
        </Card>
        <Card>
          <View style={styles.row}>
            <Text style={[styles.rowLabel, { color: theme.colors.foreground }]}>运行模式</Text>
            <View style={styles.rowValue}>
              <Ionicons name={signedIn ? 'cloud-outline' : 'phone-portrait-outline'} size={15} color={theme.colors.mutedForeground} />
              <Text style={[styles.rowText, { color: theme.colors.mutedForeground }]}>{mode}</Text>
            </View>
          </View>
        </Card>
      </Section>
      <Footnote>对话与设置保存在本机；登录后切换到账号的云端工作区。模型配置和 API key 只保存在这台设备上。</Footnote>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logo: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  identityCopy: { flex: 1, gap: 2 },
  name: { fontSize: 17, fontWeight: '700' },
  tagline: { fontSize: 12.5, lineHeight: 17 },
  version: { fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLabel: { fontSize: 14.5 },
  rowValue: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  rowText: { fontSize: 13 },
});
