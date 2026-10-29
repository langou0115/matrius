import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ThinkingEffort } from '@/core/agent/thinking-effort';
import { useModels } from '@/features/models/model-state';
import { useNativeTheme } from '@/theme/native-theme';
import { useChat, type MessageImage } from '../chat-state';
import { useChatRuntime } from '../chat-runtime';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: (images: MessageImage[]) => boolean;
  thinkingEffort: ThinkingEffort;
  onThinkingEffortChange: (value: ThinkingEffort) => void;
  onModelChange?: (id: string) => void;
  quote?: string;
  onRemoveQuote?: () => void;
  onNotice: (message: string | null) => void;
};

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const effortOptions: { value: ThinkingEffort; label: string; description: string }[] = [
  { value: 'default', label: '默认', description: '使用模型默认设置' },
  { value: 'low', label: '低', description: '更快响应，较少推理' },
  { value: 'medium', label: '中', description: '平衡响应速度与推理深度' },
  { value: 'high', label: '高', description: '适合复杂任务的深入推理' },
];

type Attachment = { id: string; uri: string; name: string; mimeType: string; size: number; base64: string };

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function mimeFor(asset: ImagePicker.ImagePickerAsset) {
  if (asset.mimeType && IMAGE_TYPES.includes(asset.mimeType)) return asset.mimeType;
  const extension = asset.fileName?.split('.').pop()?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

export function Composer({ value, onChange, onSend, thinkingEffort, onThinkingEffortChange, onModelChange, quote, onRemoveQuote, onNotice }: Props) {
  const theme = useNativeTheme();
  const input = useRef<TextInput>(null);
  const models = useModels();
  const runtime = useChatRuntime();
  const { activeId } = useChat();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [pickerPage, setPickerPage] = useState<'models' | 'thinking'>('models');
  const running = runtime.isRunning(activeId);
  const canSend = !!value.trim() || attachments.length > 0 || !!quote?.trim();
  const effortLabel = effortOptions.find((option) => option.value === thinkingEffort)?.label ?? '';

  async function pickImages() {
    onNotice(null);
    if (attachments.length >= MAX_IMAGES) {
      onNotice(`每条消息最多发送 ${MAX_IMAGES} 张图片，请移除多余附件。`);
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_IMAGES - attachments.length,
        quality: 0.8,
        base64: true,
      });
      if (result.canceled) return;
      const accepted: Attachment[] = [];
      for (const asset of result.assets) {
        const mimeType = mimeFor(asset);
        const size = asset.fileSize ?? 0;
        const name = asset.fileName ?? `图片-${Date.now()}.${mimeType.split('/')[1]}`;
        if (!IMAGE_TYPES.includes(mimeType)) { onNotice(`暂不支持文件「${name}」，目前仅支持 PNG、JPEG、WebP 或 GIF 图片。`); continue; }
        if (size > MAX_IMAGE_BYTES) { onNotice(`图片「${name}」超过 10MB，请移除或压缩后重试。`); continue; }
        if (!asset.base64) { onNotice(`读取图片「${name}」失败，请重试。`); continue; }
        accepted.push({ id: createId(), uri: asset.uri, name, mimeType, size, base64: asset.base64 });
      }
      if (accepted.length) setAttachments((current) => [...current, ...accepted].slice(0, MAX_IMAGES));
    } catch {
      onNotice('打开相册失败，请重试。');
    }
  }

  async function submit() {
    if (preparing || !canSend) return;
    if (!models.ready || !models.selected) { onNotice(models.error ?? '请先在设置 → 模型服务中添加并选择模型。'); return; }
    if (attachments.length && !models.selected.supportsImage) { onNotice('当前模型未开启图片输入，请切换支持图片的模型，或在模型设置中确认图片输入能力。'); return; }
    setPreparing(true);
    try {
      const images: MessageImage[] = attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        dataUrl: `data:${attachment.mimeType};base64,${attachment.base64}`,
        ...(attachment.size ? { size: attachment.size } : {}),
      }));
      if (!onSend(images)) return;
      setAttachments([]);
      onNotice(null);
      input.current?.focus();
    } finally {
      setPreparing(false);
    }
  }

  async function selectModel(id: string) {
    try {
      await models.select(id);
      onModelChange?.(id);
      onNotice(null);
      setShowPicker(false);
      setPickerPage('models');
    } catch {
      onNotice('切换模型失败，请重试。');
    }
  }

  const selectedModel = models.selected;
  const selectedProviderIndex = selectedModel
    ? models.providers.findIndex((provider) => provider.models.some((model) => model.id === selectedModel.id))
    : -1;
  const orderedProviders = selectedProviderIndex > 0
    ? [models.providers[selectedProviderIndex], ...models.providers.slice(0, selectedProviderIndex), ...models.providers.slice(selectedProviderIndex + 1)]
    : models.providers;

  return (
    <>
      <View style={[styles.composer, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
        {quote ? (
          <View style={[styles.quote, { backgroundColor: theme.colors.muted, borderRadius: Math.min(theme.radius, 10) }]}>
            <Text numberOfLines={3} style={[styles.quoteText, { color: theme.colors.mutedForeground }]}>{quote}</Text>
            {onRemoveQuote ? (
              <Pressable accessibilityRole="button" accessibilityLabel="移除引用" hitSlop={8} onPress={onRemoveQuote}>
                <Ionicons name="close" size={16} color={theme.colors.mutedForeground} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {attachments.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.attachmentRow}>
            {attachments.map((attachment) => (
              <View key={attachment.id} style={styles.attachment}>
                <Image source={{ uri: attachment.uri }} style={[styles.attachmentImage, { borderColor: theme.colors.border }]} />
                <Pressable accessibilityRole="button" accessibilityLabel={`移除图片 ${attachment.name}`} hitSlop={8}
                  onPress={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  style={[styles.removeAttachment, { backgroundColor: theme.colors.foreground }]}>
                  <Ionicons name="close" size={12} color={theme.colors.background} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <TextInput
          ref={input}
          accessibilityLabel="消息内容"
          multiline
          value={value}
          onChangeText={onChange}
          placeholder={attachments.length ? '' : '发消息，探索更多可能…'}
          placeholderTextColor={theme.colors.mutedForeground}
          editable={!preparing}
          style={[styles.input, { color: theme.colors.foreground }]}
        />

        <View style={styles.toolbar}>
          <Pressable accessibilityRole="button" accessibilityLabel="添加附件" hitSlop={8} onPress={() => { void pickImages(); }}
            style={({ pressed }) => [styles.toolButton, { opacity: pressed ? 0.5 : 1 }]}>
            <Ionicons name="attach" size={23} color={theme.colors.mutedForeground} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={selectedModel ? `选择模型，当前为${selectedModel.name}，思考强度${effortLabel}` : '选择模型，当前未选择模型'}
            onPress={() => { setShowPicker(true); setPickerPage('models'); onNotice(models.error); }}
            style={({ pressed }) => [styles.modelButton, { backgroundColor: theme.colors.muted, borderRadius: Math.min(theme.radius, 12), opacity: pressed ? 0.7 : 1 }]}>
            <Ionicons name="hardware-chip-outline" size={15} color={theme.colors.foreground} />
            <Text numberOfLines={1} style={[styles.modelLabel, { color: theme.colors.foreground }]}>{selectedModel?.name ?? '选择模型'}</Text>
            {selectedModel ? <Text style={[styles.effort, { color: theme.colors.mutedForeground }]}>{effortLabel}</Text> : null}
            <Ionicons name="chevron-up" size={14} color={theme.colors.mutedForeground} />
          </Pressable>
          <View style={styles.spacer} />
          {running && !canSend ? (
            <Pressable accessibilityRole="button" accessibilityLabel="停止生成" hitSlop={8}
              onPress={() => runtime.stop(activeId ?? undefined)}
              style={[styles.send, { backgroundColor: theme.colors.foreground }]}>
              <Ionicons name="stop" size={18} color={theme.colors.background} />
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel={running ? '发送补充或纠正' : '发送消息'}
              disabled={!canSend || preparing} onPress={() => { void submit(); }}
              style={[styles.send, { backgroundColor: canSend ? theme.colors.primary : theme.colors.muted }]}>
              {preparing ? <ActivityIndicator size="small" color={theme.colors.primaryForeground} />
                : <Ionicons name="arrow-up" size={19} color={canSend ? theme.colors.primaryForeground : theme.colors.mutedForeground} />}
            </Pressable>
          )}
        </View>
      </View>

      <Modal visible={showPicker} transparent animationType="slide" onRequestClose={() => setShowPicker(false)}>
        <View style={styles.pickerBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭模型选择" onPress={() => setShowPicker(false)} />
          <SafeAreaView edges={['bottom']} style={[styles.picker, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            {pickerPage === 'models' ? (
              <>
                <View style={[styles.pickerHeader, { borderBottomColor: theme.colors.border }]}>
                  <Text style={[styles.pickerTitle, { color: theme.colors.foreground }]}>选择模型</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="关闭" hitSlop={8} onPress={() => setShowPicker(false)}>
                    <Ionicons name="close" size={22} color={theme.colors.mutedForeground} />
                  </Pressable>
                </View>
                <ScrollView style={styles.pickerScroll} contentContainerStyle={styles.pickerContent}>
                  {models.models.length ? orderedProviders.filter((provider) => provider.models.length > 0).map((provider) => (
                    <View key={provider.id} style={styles.providerGroup}>
                      <Text style={[styles.providerName, { color: theme.colors.mutedForeground }]}>{provider.name}</Text>
                      {provider.models.map((model) => {
                        const active = models.selectedId === model.id;
                        return (
                          <Pressable key={model.id} accessibilityRole="button" accessibilityState={{ selected: active }}
                            disabled={running} onPress={() => { void selectModel(model.id); }}
                            style={({ pressed }) => [styles.modelRow, { backgroundColor: active ? theme.colors.accent : 'transparent', borderRadius: Math.min(theme.radius, 10), opacity: running ? 0.5 : pressed ? 0.7 : 1 }]}>
                            <Text style={[styles.modelName, { color: theme.colors.foreground }]}>{model.name}</Text>
                            {active ? <Ionicons name="checkmark" size={17} color={theme.colors.primary} /> : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  )) : <Text style={[styles.empty, { color: theme.colors.mutedForeground }]}>还没有可用模型</Text>}
                </ScrollView>
                {selectedModel ? (
                  <Pressable accessibilityRole="button" disabled={running} onPress={() => setPickerPage('thinking')}
                    style={({ pressed }) => [styles.thinkingRow, { borderTopColor: theme.colors.border, opacity: pressed ? 0.7 : 1 }]}>
                    <Text style={[styles.modelName, { color: theme.colors.foreground }]}>思考强度</Text>
                    <Text style={[styles.effort, { color: theme.colors.mutedForeground }]}>{effortLabel}</Text>
                    <Ionicons name="chevron-forward" size={16} color={theme.colors.mutedForeground} />
                  </Pressable>
                ) : null}
                <Pressable accessibilityRole="button" onPress={() => { setShowPicker(false); router.push('/settings/models'); }}
                  style={({ pressed }) => [styles.manageRow, { borderTopColor: theme.colors.border, opacity: pressed ? 0.7 : 1 }]}>
                  <Ionicons name="settings-outline" size={16} color={theme.colors.mutedForeground} />
                  <Text style={[styles.manageLabel, { color: theme.colors.mutedForeground }]}>管理模型服务</Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={[styles.pickerHeader, { borderBottomColor: theme.colors.border }]}>
                  <Pressable accessibilityRole="button" accessibilityLabel="返回模型列表" hitSlop={8} onPress={() => setPickerPage('models')}>
                    <Ionicons name="chevron-back" size={22} color={theme.colors.foreground} />
                  </Pressable>
                  <Text style={[styles.pickerTitle, { color: theme.colors.foreground }]}>思考强度</Text>
                  <View style={styles.headerSpacer} />
                </View>
                <View style={styles.pickerContent}>
                  {effortOptions.map((option) => (
                    <Pressable key={option.value} accessibilityRole="button" accessibilityState={{ selected: thinkingEffort === option.value }}
                      disabled={running} onPress={() => { onThinkingEffortChange(option.value); setPickerPage('models'); }}
                      style={({ pressed }) => [styles.effortRow, { opacity: running ? 0.5 : pressed ? 0.7 : 1 }]}>
                      <View style={styles.effortCopy}>
                        <Text style={[styles.modelName, { color: theme.colors.foreground }]}>{option.label}</Text>
                        <Text style={[styles.effortDescription, { color: theme.colors.mutedForeground }]}>{option.description}</Text>
                      </View>
                      {thinkingEffort === option.value ? <Ionicons name="checkmark" size={18} color={theme.colors.primary} /> : null}
                    </Pressable>
                  ))}
                </View>
              </>
            )}
          </SafeAreaView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8, gap: 8 },
  quote: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 8 },
  quoteText: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  attachmentRow: { gap: 8, paddingVertical: 2 },
  attachment: { width: 64, height: 64 },
  attachmentImage: { width: 64, height: 64, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth },
  removeAttachment: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 42, maxHeight: 132, fontSize: 16, lineHeight: 23, paddingHorizontal: 2, paddingTop: 4, paddingBottom: 4, textAlignVertical: 'top' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  modelButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 34, maxWidth: '62%' },
  modelLabel: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
  effort: { fontSize: 11 },
  spacer: { flex: 1 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  picker: { maxHeight: '78%', borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  pickerHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth },
  pickerTitle: { fontSize: 16, fontWeight: '600' },
  headerSpacer: { width: 22 },
  pickerScroll: { flexGrow: 0 },
  pickerContent: { paddingHorizontal: 12, paddingVertical: 8, gap: 4 },
  providerGroup: { gap: 2, paddingVertical: 4 },
  providerName: { fontSize: 11, paddingHorizontal: 10, paddingVertical: 4, textTransform: 'uppercase' },
  modelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, paddingHorizontal: 10 },
  modelName: { fontSize: 15 },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 50, paddingHorizontal: 18, borderTopWidth: StyleSheet.hairlineWidth },
  manageRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 46, paddingHorizontal: 18, borderTopWidth: StyleSheet.hairlineWidth },
  manageLabel: { fontSize: 13 },
  effortRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 54, paddingHorizontal: 8 },
  effortCopy: { flex: 1, gap: 2 },
  effortDescription: { fontSize: 12, lineHeight: 17 },
  empty: { fontSize: 14, textAlign: 'center', paddingVertical: 28 },
});
