import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/native/button';
import { Dialog } from '@/components/native/dialog';
import { fetchProviderCatalog, type CatalogModel } from '@/core/llm/provider-catalog';
import { protocols, type ProviderModelConfig } from '@/core/llm/model-config';
import { useChatRuntime } from '@/features/chat/chat-runtime';
import { useNativeTheme } from '@/theme/native-theme';
import { Divider, Footnote, Section, SettingsPage } from '@/features/settings/native/settings-shell';
import { useModels } from '../model-state';
import { ProviderFormDialog } from './provider-form';

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请重试。';
}

export function ProviderScreen({ providerId }: { providerId: string }) {
  const theme = useNativeTheme();
  const models = useModels();
  const { isAnyRunning } = useChatRuntime();
  const found = models.providers.find((item) => item.id === providerId) ?? null;
  const [editingProvider, setEditingProvider] = useState(false);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogModels, setCatalogModels] = useState<CatalogModel[]>([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const catalogRequest = useRef(0);
  const disabled = saving || !models.ready || isAnyRunning;

  if (!found) {
    return (
      <SettingsPage title="模型服务">
        <Footnote error>找不到这个服务商，它可能已被删除。</Footnote>
        <Button label="返回模型服务" onPress={() => router.back()} />
      </SettingsPage>
    );
  }

  const provider = found;
  const protocolLabel = protocols.find((item) => item.id === provider.protocol)?.label ?? provider.protocol;
  const keyStatus = provider.requiresApiKey ? (models.getKey(provider.id) ? '已保存 API key' : '需要 API key') : '无需 API key';
  const query = catalogFilter.trim().toLowerCase();
  const catalogMatches = query
    ? catalogModels.filter((item) => item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query))
    : catalogModels;

  function closeCatalog() {
    catalogRequest.current += 1;
    setCatalogOpen(false);
    setCatalogModels([]);
    setCatalogFilter('');
    setCatalogError(null);
    setCatalogLoading(false);
  }

  async function discover() {
    const token = ++catalogRequest.current;
    setCatalogOpen(true);
    setCatalogFilter('');
    setCatalogError(null);
    setCatalogModels([]);
    setCatalogLoading(true);
    try {
      const catalog = await fetchProviderCatalog(provider, models.getKey(provider.id));
      if (catalogRequest.current === token) setCatalogModels(catalog);
    } catch (reason) {
      if (catalogRequest.current === token) setCatalogError(errorMessage(reason));
    } finally {
      if (catalogRequest.current === token) setCatalogLoading(false);
    }
  }

  async function addCatalogModel(item: CatalogModel) {
    if (provider.models.some((model) => model.modelId === item.id)) return;
    setSaving(true);
    setCatalogError(null);
    try {
      await models.saveModel(provider.id, {
        id: createId(), name: item.name, modelId: item.id, supportsImage: false, contextWindow: 128000, maxOutput: 4096,
      });
      setNotice('模型已添加。');
    } catch (reason) {
      setCatalogError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function removeModel(model: ProviderModelConfig) {
    setSaving(true);
    setFailure(null);
    try {
      await models.removeModel(model.id);
      setNotice('已删除模型配置。');
    } catch (reason) {
      setFailure(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function removeProvider() {
    setSaving(true);
    try {
      await models.removeProvider(provider.id);
      setConfirmDeleteProvider(false);
      router.back();
    } catch (reason) {
      setFailure(errorMessage(reason));
      setConfirmDeleteProvider(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage title={provider.name} subtitle={`${provider.models.length} 个模型`}>
      {models.error ? <Footnote error>{models.error}</Footnote> : null}
      {isAnyRunning ? <Footnote>正在生成回复，请先停止或等待完成后再修改配置。</Footnote> : null}

      <Section title="服务商">
        <View style={styles.providerInfo}>
          <Text style={[styles.providerName, { color: theme.colors.foreground }]}>{provider.name}</Text>
          <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>{protocolLabel}</Text>
          <Text selectable style={[styles.meta, { color: theme.colors.mutedForeground }]}>{provider.baseUrl}</Text>
          <Text style={[styles.meta, { color: theme.colors.mutedForeground }]}>{keyStatus}</Text>
          <View style={styles.providerActions}>
            <Button label="编辑服务商" onPress={() => { setFailure(null); setEditingProvider(true); }} disabled={disabled} />
            <Button label="删除服务商" variant="ghost" onPress={() => setConfirmDeleteProvider(true)} disabled={disabled} />
          </View>
        </View>
      </Section>

      <Section title="模型">
        <View style={styles.modelActions}>
          <Button label="获取模型列表" onPress={() => { void discover(); }} disabled={disabled} />
          <Button label="手动添加" variant="primary"
            onPress={() => router.push(`/settings/models/${encodeURIComponent(provider.id)}/new`)} disabled={disabled} />
        </View>
        {provider.models.length ? provider.models.map((model, index) => (
          <View key={model.id}>
            {index > 0 ? <Divider /> : null}
            <Pressable accessibilityRole="button" accessibilityLabel={`编辑模型：${model.name}`}
              onPress={() => router.push(`/settings/models/${encodeURIComponent(provider.id)}/${encodeURIComponent(model.id)}`)}
              style={({ pressed }) => [styles.modelRow, { opacity: pressed ? 0.6 : 1 }]}>
              <View style={styles.modelCopy}>
                <Text style={[styles.modelName, { color: theme.colors.foreground }]}>{model.name}</Text>
                <Text numberOfLines={2} style={[styles.meta, { color: theme.colors.mutedForeground }]}>
                  {model.modelId} · 上下文 {model.contextWindow.toLocaleString()} · 最大输出 {model.maxOutput.toLocaleString()}{model.supportsImage ? ' · 支持图片' : ''}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`删除模型：${model.name}`} hitSlop={8}
                disabled={disabled} onPress={() => { void removeModel(model); }} style={styles.trash}>
                <Ionicons name="trash-outline" size={18} color={theme.colors.destructive} />
              </Pressable>
            </Pressable>
          </View>
        )) : <Text style={[styles.empty, { color: theme.colors.mutedForeground }]}>还没有添加模型。</Text>}
      </Section>

      {failure ? <Footnote error>{failure}</Footnote> : null}
      {notice ? <Footnote>{notice}</Footnote> : null}

      {editingProvider ? (
        <ProviderFormDialog provider={provider} disabled={disabled}
          onSaved={() => setNotice('服务商已保存。')} onClose={() => setEditingProvider(false)} />
      ) : null}

      <Dialog visible={catalogOpen} title={`${provider.name} 的模型列表`}
        description="直接向服务商获取，选择要用的模型加进来。"
        onClose={closeCatalog}
        footer={
          <View style={styles.footer}>
            <Button label="重新获取" disabled={catalogLoading || disabled} onPress={() => { void discover(); }} />
            <Button label="完成" variant="primary" onPress={closeCatalog} />
          </View>
        }>
        {catalogError ? <Footnote error>{catalogError}</Footnote> : null}
        {catalogLoading ? <Text style={[styles.catalogStatus, { color: theme.colors.mutedForeground }]}>正在获取模型列表…</Text> : null}
        {!catalogLoading && catalogModels.length ? (
          <>
            <TextInput value={catalogFilter} onChangeText={setCatalogFilter} placeholder="筛选名称或模型 ID"
              placeholderTextColor={theme.colors.mutedForeground} autoCapitalize="none" autoCorrect={false}
              style={[styles.filter, { color: theme.colors.foreground, borderColor: theme.colors.input, borderRadius: Math.min(theme.radius, 10) }]} />
            <Text style={[styles.catalogStatus, { color: theme.colors.mutedForeground }]}>
              {query ? `匹配 ${catalogMatches.length} / ${catalogModels.length} 个模型` : `共 ${catalogModels.length} 个模型`}
            </Text>
            <ScrollView style={styles.catalogList} nestedScrollEnabled>
              {catalogMatches.map((item) => {
                const added = provider.models.some((model) => model.modelId === item.id);
                return (
                  <View key={item.id} style={[styles.catalogRow, { borderBottomColor: theme.colors.border }]}>
                    <View style={styles.catalogCopy}>
                      <Text numberOfLines={1} style={[styles.catalogName, { color: theme.colors.foreground }]}>{item.name}</Text>
                      {item.name !== item.id ? <Text numberOfLines={1} style={[styles.meta, { color: theme.colors.mutedForeground }]}>{item.id}</Text> : null}
                    </View>
                    <Button label={added ? '已添加' : '添加'} disabled={added || disabled} onPress={() => { void addCatalogModel(item); }} />
                  </View>
                );
              })}
              {!catalogMatches.length ? <Text style={[styles.catalogStatus, { color: theme.colors.mutedForeground }]}>没有匹配「{catalogFilter.trim()}」的模型。</Text> : null}
            </ScrollView>
          </>
        ) : null}
        {!catalogLoading && !catalogError && !catalogModels.length ? (
          <Text style={[styles.catalogStatus, { color: theme.colors.mutedForeground }]}>服务商没有返回模型，可以手动填写模型 ID。</Text>
        ) : null}
      </Dialog>

      <Dialog visible={confirmDeleteProvider} title="删除服务商？"
        description={`“${provider.name}”及其模型配置将被删除，已有对话会保留。`}
        onClose={() => setConfirmDeleteProvider(false)}
        footer={
          <View style={styles.footer}>
            <Button label="取消" variant="secondary" onPress={() => setConfirmDeleteProvider(false)} disabled={saving} />
            <Button label="删除服务商" variant="destructive" loading={saving} onPress={() => { void removeProvider(); }} />
          </View>
        } />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  providerInfo: { padding: 14, gap: 5 },
  providerName: { fontSize: 16, fontWeight: '700' },
  meta: { fontSize: 12.5, lineHeight: 18 },
  providerActions: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  modelActions: { flexDirection: 'row', gap: 8, padding: 12 },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  modelCopy: { flex: 1, gap: 3 },
  modelName: { fontSize: 14.5, fontWeight: '600' },
  trash: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  empty: { fontSize: 13, paddingHorizontal: 14, paddingVertical: 16 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
  catalogStatus: { fontSize: 12.5, lineHeight: 18 },
  filter: { borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 11, paddingVertical: 9, fontSize: 14 },
  catalogList: { maxHeight: 320 },
  catalogRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  catalogCopy: { flex: 1, gap: 2 },
  catalogName: { fontSize: 14 },
});
