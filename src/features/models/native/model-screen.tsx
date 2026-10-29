import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/components/native/button';
import { Dialog } from '@/components/native/dialog';
import { Field } from '@/components/native/field';
import { useChatRuntime } from '@/features/chat/chat-runtime';
import { Footnote, Section, SettingsPage } from '@/features/settings/native/settings-shell';
import { useNativeTheme } from '@/theme/native-theme';
import { useModels } from '../model-state';

type ModelForm = { name: string; modelId: string; supportsImage: boolean; contextWindow: string; maxOutput: string };

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `model-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请重试。';
}

export function ModelScreen({ providerId, modelId }: { providerId: string; modelId: string }) {
  const theme = useNativeTheme();
  const models = useModels();
  const { isAnyRunning } = useChatRuntime();
  const provider = models.providers.find((item) => item.id === providerId) ?? null;
  const existing = provider?.models.find((item) => item.id === modelId) ?? null;
  const creating = modelId === 'new';
  const [modelKey] = useState(() => creating ? createId() : modelId);
  const [form, setForm] = useState<ModelForm>(() => existing ? {
    name: existing.name, modelId: existing.modelId, supportsImage: existing.supportsImage,
    contextWindow: String(existing.contextWindow), maxOutput: String(existing.maxOutput),
  } : { name: '', modelId: '', supportsImage: false, contextWindow: '128000', maxOutput: '4096' });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = saving || !models.ready || isAnyRunning;

  if (!provider || (!creating && !existing)) {
    return (
      <SettingsPage title="模型配置">
        <Footnote error>找不到这个模型，它可能已被删除。</Footnote>
        <Button label="返回" onPress={() => router.back()} />
      </SettingsPage>
    );
  }

  async function save() {
    if (!provider || saving) return;
    const contextWindow = Number(form.contextWindow);
    const maxOutput = Number(form.maxOutput);
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(maxOutput) || contextWindow < 1 || maxOutput < 1) {
      setError('上下文窗口与最大输出都需要填写正整数。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await models.saveModel(provider.id, {
        id: modelKey, name: form.name, modelId: form.modelId,
        supportsImage: form.supportsImage, contextWindow, maxOutput,
      });
      router.back();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await models.removeModel(modelKey);
      setConfirmDelete(false);
      router.back();
    } catch (reason) {
      setError(errorMessage(reason));
      setConfirmDelete(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsPage title={creating ? '添加模型' : '编辑模型'} subtitle={provider.name}>
      {models.error ? <Footnote error>{models.error}</Footnote> : null}
      {isAnyRunning ? <Footnote>正在生成回复，请先停止或等待完成后再修改配置。</Footnote> : null}

      <Section title="模型信息">
        <View style={styles.fields}>
          <Field label="显示名称" value={form.name} onChangeText={(value) => setForm({ ...form, name: value })}
            placeholder="例如：日常对话" maxLength={100} />
          <Field label="模型 ID" value={form.modelId} onChangeText={(value) => setForm({ ...form, modelId: value })}
            placeholder="服务商返回的准确模型 ID" autoCapitalize="none" autoCorrect={false} />
          <View style={styles.toggle}>
            <View style={styles.toggleCopy}>
              <Text style={[styles.toggleTitle, { color: theme.colors.foreground }]}>支持图片输入</Text>
              <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>仅在服务商和该模型本身支持视觉输入时开启。</Text>
            </View>
            <Switch value={form.supportsImage} onValueChange={(value) => setForm({ ...form, supportsImage: value })}
              trackColor={{ true: theme.colors.primary, false: theme.colors.muted }} thumbColor={theme.colors.background} />
          </View>
          <View style={styles.columns}>
            <View style={styles.column}>
              <Field label="上下文窗口" value={form.contextWindow} keyboardType="number-pad"
                onChangeText={(value) => setForm({ ...form, contextWindow: value.replace(/[^0-9]/g, '') })} />
            </View>
            <View style={styles.column}>
              <Field label="最大输出 tokens" value={form.maxOutput} keyboardType="number-pad"
                onChangeText={(value) => setForm({ ...form, maxOutput: value.replace(/[^0-9]/g, '') })} />
            </View>
          </View>
        </View>
      </Section>

      {error ? <Footnote error>{error}</Footnote> : null}

      <View style={styles.actions}>
        <Button label={saving ? '保存中…' : '保存模型'} variant="primary" loading={saving}
          disabled={disabled || !form.name.trim() || !form.modelId.trim()} onPress={() => { void save(); }} />
        {!creating ? <Button label="删除模型" variant="ghost" disabled={disabled} onPress={() => setConfirmDelete(true)} /> : null}
      </View>

      <Dialog visible={confirmDelete} title="删除模型？" description={`“${existing?.name ?? ''}”的配置会被删除，已有对话会保留。`}
        onClose={() => setConfirmDelete(false)}
        footer={
          <View style={styles.footer}>
            <Button label="取消" variant="secondary" disabled={saving} onPress={() => setConfirmDelete(false)} />
            <Button label="删除模型" variant="destructive" loading={saving} onPress={() => { void remove(); }} />
          </View>
        } />
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  fields: { padding: 14, gap: 14 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleCopy: { flex: 1, gap: 3 },
  toggleTitle: { fontSize: 14, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 17 },
  columns: { flexDirection: 'row', gap: 10 },
  column: { flex: 1 },
  actions: { gap: 8 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
});
