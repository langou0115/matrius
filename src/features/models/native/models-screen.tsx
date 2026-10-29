import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/native/button';
import { protocols, type ProviderConfig } from '@/core/llm/model-config';
import { useChatRuntime } from '@/features/chat/chat-runtime';
import { Divider, Footnote, Section, SettingsPage } from '@/features/settings/native/settings-shell';
import { useNativeTheme } from '@/theme/native-theme';
import { useModels } from '../model-state';
import { ProviderFormDialog } from './provider-form';

function createProvider(): ProviderConfig {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: '', protocol: 'completion', baseUrl: protocols[0].baseUrl, requiresApiKey: true, models: [],
  };
}

export function ModelsScreen() {
  const theme = useNativeTheme();
  const models = useModels();
  const { isAnyRunning } = useChatRuntime();
  const [draft, setDraft] = useState<ProviderConfig | null>(null);
  const disabled = !models.ready || isAnyRunning;

  return (
    <SettingsPage
      title="模型服务"
      subtitle="按服务商管理连接信息，再发现并添加要使用的模型。"
      right={models.providers.length ? <Button label="添加" onPress={() => setDraft(createProvider())} disabled={disabled} /> : undefined}
    >
      {models.error ? <Footnote error>{models.error}</Footnote> : null}
      {!models.ready && !models.error ? <Footnote>正在读取模型配置…</Footnote> : null}
      {isAnyRunning ? <Footnote>正在生成回复，请先停止或等待完成后再修改配置。</Footnote> : null}

      {models.providers.length ? (
        <Section title="服务商">
          {models.providers.map((provider, index) => {
            const protocolLabel = protocols.find((item) => item.id === provider.protocol)?.label ?? provider.protocol;
            const keyStatus = provider.requiresApiKey
              ? (models.getKey(provider.id) ? '已保存 API key' : '需要 API key')
              : '无需 API key';
            return (
              <View key={provider.id}>
                {index > 0 ? <Divider /> : null}
                <Pressable accessibilityRole="button" accessibilityLabel={`${provider.name}，${provider.models.length} 个模型`}
                  onPress={() => router.push(`/settings/models/${encodeURIComponent(provider.id)}`)}
                  style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}>
                  <View style={[styles.icon, { backgroundColor: theme.colors.muted, borderRadius: Math.min(theme.radius, 10) }]}>
                    <Ionicons name="server-outline" size={18} color={theme.colors.foreground} />
                  </View>
                  <View style={styles.copy}>
                    <Text style={[styles.name, { color: theme.colors.foreground }]}>{provider.name}</Text>
                    <Text numberOfLines={1} style={[styles.meta, { color: theme.colors.mutedForeground }]}>
                      {protocolLabel} · {provider.baseUrl}
                    </Text>
                    <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>
                      {provider.models.length} 个模型 · {keyStatus}
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={17} color={theme.colors.mutedForeground} />
                </Pressable>
              </View>
            );
          })}
        </Section>
      ) : models.ready ? (
        <Section>
          <View style={styles.empty}>
            <Ionicons name="server-outline" size={24} color={theme.colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: theme.colors.foreground }]}>还没有服务商</Text>
            <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>添加服务商后，即可获取或手动添加模型。</Text>
            <Button label="添加服务商" variant="primary" onPress={() => setDraft(createProvider())} disabled={disabled} />
          </View>
        </Section>
      ) : null}

      <Footnote>
        API key 保存在系统钥匙串中，只在这台设备上使用；对话与模型配置不会上传 API key。
      </Footnote>

      {draft ? (
        <ProviderFormDialog provider={draft} disabled={disabled} onClose={() => setDraft(null)}
          onSaved={() => {
            const id = draft.id;
            setDraft(null);
            router.push(`/settings/models/${encodeURIComponent(id)}`);
          }} />
      ) : null}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  icon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 12, lineHeight: 17 },
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 26 },
  emptyTitle: { fontSize: 15, fontWeight: '600' },
});
