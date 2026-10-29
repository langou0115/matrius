import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { Button } from '@/components/native/button';
import { Dialog } from '@/components/native/dialog';
import { Field } from '@/components/native/field';
import { protocols, type ProviderConfig } from '@/core/llm/model-config';
import { useNativeTheme } from '@/theme/native-theme';
import { useModels } from '../model-state';

type ProviderForm = Omit<ProviderConfig, 'models'>;

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newProvider(): ProviderForm {
  return { id: createId(), name: '', protocol: 'completion', baseUrl: protocols[0].baseUrl, requiresApiKey: true };
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '操作失败，请重试。';
}

/** Add or edit one provider. The API key is written to SecureStore separately from the config. */
export function ProviderFormDialog({ provider, disabled, onSaved, onClose }: {
  provider: ProviderConfig | null;
  disabled?: boolean;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const theme = useNativeTheme();
  const models = useModels();
  const [form, setForm] = useState<ProviderForm>(() => provider ? {
    id: provider.id, name: provider.name, protocol: provider.protocol, baseUrl: provider.baseUrl, requiresApiKey: provider.requiresApiKey,
  } : newProvider());
  const [apiKey, setApiKey] = useState(() => provider ? models.getKey(provider.id) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = models.providers.some((item) => item.id === form.id);

  async function save() {
    if (saving || disabled) return;
    setSaving(true);
    setError(null);
    try {
      await models.saveProvider({ ...form, models: provider?.models ?? [] }, apiKey);
      onSaved?.();
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      visible
      title={editing ? '编辑服务商' : '添加服务商'}
      onClose={onClose}
      footer={
        <View style={styles.footer}>
          <Button label="取消" variant="secondary" onPress={onClose} disabled={saving} />
          <Button label={saving ? '保存中…' : '保存服务商'} variant="primary" onPress={() => { void save(); }} loading={saving} disabled={disabled || !form.name.trim()} />
        </View>
      }
    >
      <Field label="服务商名称" value={form.name} onChangeText={(value) => setForm({ ...form, name: value })}
        placeholder="例如：OpenAI、我的网关" maxLength={100} />
      <View style={styles.protocols}>
        <Text style={[styles.label, { color: theme.colors.foreground }]}>接口协议</Text>
        {protocols.map((item) => (
          <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: form.protocol === item.id }}
            onPress={() => {
              const usingDefault = protocols.some((value) => value.baseUrl === form.baseUrl);
              setForm({ ...form, protocol: item.id, baseUrl: usingDefault ? item.baseUrl : form.baseUrl });
            }}
            style={({ pressed }) => [styles.protocol, {
              borderColor: form.protocol === item.id ? theme.colors.primary : theme.colors.border,
              borderRadius: Math.min(theme.radius, 10), opacity: pressed ? 0.7 : 1,
            }]}>
            <Text style={[styles.protocolLabel, { color: theme.colors.foreground }]}>{item.label}</Text>
            {form.protocol === item.id ? <Text style={[styles.check, { color: theme.colors.primary }]}>✓</Text> : null}
          </Pressable>
        ))}
      </View>
      <Field label="Base URL" value={form.baseUrl} onChangeText={(value) => setForm({ ...form, baseUrl: value })}
        placeholder="https://your-provider.example/v1" autoCapitalize="none" autoCorrect={false} keyboardType="url"
        hint="填写 API 基础地址，不包含 /models、/chat/completions、/responses 或 /messages。" />
      <View style={styles.toggle}>
        <View style={styles.toggleCopy}>
          <Text style={[styles.label, { color: theme.colors.foreground }]}>接口需要 API key</Text>
          <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>关闭后请求不会携带鉴权头。</Text>
        </View>
        <Switch value={form.requiresApiKey} onValueChange={(value) => setForm({ ...form, requiresApiKey: value })}
          trackColor={{ true: theme.colors.primary, false: theme.colors.muted }} thumbColor={theme.colors.background} />
      </View>
      {form.requiresApiKey ? (
        <Field label="API key" value={apiKey} onChangeText={setApiKey} secureTextEntry autoCapitalize="none" autoCorrect={false}
          placeholder={editing && models.getKey(form.id) ? '已填写；留空保持当前 key' : '保存在此设备的钥匙串中'}
          hint="API key 保存在系统钥匙串，不写入对话数据，也不会同步到云端。" />
      ) : null}
      {error ? <Text style={[styles.error, { color: theme.colors.destructive }]}>{error}</Text> : null}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, flex: 1 },
  protocols: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600' },
  protocol: { borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  protocolLabel: { fontSize: 14 },
  check: { fontSize: 15, fontWeight: '700' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleCopy: { flex: 1, gap: 3 },
  hint: { fontSize: 12, lineHeight: 17 },
  error: { fontSize: 13, lineHeight: 19 },
});
