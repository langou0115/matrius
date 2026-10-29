import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/native/button';
import { ApiError } from '@/core/api/auth-session';
import { useAuth, useFeature } from '@/features/auth/auth-state';
import { useNativeTheme } from '@/theme/native-theme';
import { Divider, Footnote, Section, SettingsPage } from './settings-shell';

type Feature = { id: string; name: string; description: string; stage: 'preview' | 'stable' };

function AuthorizedLabs() {
  const theme = useNativeTheme();
  const auth = useAuth();
  const { request, refresh } = auth;
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    request<{ features: Feature[] }>('/api/features/labs', { signal: abort.signal }).then((result) => {
      if (active) setFeatures(result.features);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError('暂时无法获取已开放的功能，请重试。');
      if (reason instanceof ApiError && reason.status === 403) void refresh();
    });
    return () => { active = false; abort.abort(); };
  }, [attempt, request, refresh]);

  return (
    <SettingsPage title="实验功能" subtitle="提前体验当前账号已开放的新功能。">
      <Section title="当前可用">
        {!features && !error ? <Text style={[styles.status, { color: theme.colors.mutedForeground }]}>正在获取功能…</Text> : null}
        {features?.map((feature, index) => (
          <View key={feature.id}>
            {index > 0 ? <Divider /> : null}
            <View style={styles.row}>
              <View style={styles.copy}>
                <Text style={[styles.name, { color: theme.colors.foreground }]}>{feature.name}</Text>
                <Text style={[styles.description, { color: theme.colors.mutedForeground }]}>{feature.description}</Text>
              </View>
              <Text style={[styles.stage, { color: theme.colors.mutedForeground }]}>{feature.stage === 'preview' ? '测试中' : '已验证'}</Text>
            </View>
          </View>
        ))}
        {features?.length === 0 ? <Text style={[styles.status, { color: theme.colors.mutedForeground }]}>当前没有可用的实验功能。</Text> : null}
      </Section>
      {error ? <>
        <Footnote error>{error}</Footnote>
        <Button label="重试" onPress={() => { setError(null); setFeatures(null); setAttempt((value) => value + 1); }} />
      </> : null}
    </SettingsPage>
  );
}

export function LabsScreen() {
  const auth = useAuth();
  const enabled = useFeature('labs');
  if (auth.status === 'checking') return <SettingsPage title="设置" subtitle="正在验证账号权限…" />;
  if (!enabled || !auth.user) return <Redirect href="/settings/account" />;
  return <AuthorizedLabs key={`${auth.user.id}:${auth.user.features.join(',')}`} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  copy: { flex: 1, gap: 3 },
  name: { fontSize: 14.5, fontWeight: '600' },
  description: { fontSize: 12.5, lineHeight: 18 },
  stage: { fontSize: 11.5 },
  status: { fontSize: 13, paddingHorizontal: 14, paddingVertical: 14 },
});
