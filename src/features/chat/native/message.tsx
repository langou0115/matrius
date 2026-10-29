import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { memo, useEffect, useState, type ComponentProps } from 'react';
import { Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import type { MessageFeedback, ProcessActivity, WebActivity, WebSearchResult } from '@/core/agent/types';
import type { Message } from '../chat-state';
import { getCopyText } from '../message-text';
import { useNativeTheme } from '@/theme/native-theme';
import { MessageContent } from './message-content';

export type ReasoningState = 'running' | 'complete' | 'stopped' | 'error';

export function getReasoningState(message: Pick<Message, 'status'>): ReasoningState {
  if (message.status === 'streaming') return 'running';
  if (message.status === 'stopped') return 'stopped';
  if (message.status === 'error') return 'error';
  return 'complete';
}

function formatElapsed(seconds: number) {
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function formatTook(ms: number) {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function hostname(url: string | undefined) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function useElapsed(startedAt: number | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
}

function activityLabel(activity: WebActivity): string {
  if (activity.status === 'stopped') return activity.kind === 'search' ? '搜索已停止' : '读取已停止';
  if (activity.kind === 'search') {
    return activity.status === 'error' ? '搜索失败' : activity.status === 'running' ? '正在搜索' : '已搜索';
  }
  return activity.status === 'error' ? '读取失败' : activity.status === 'running' ? '正在读取' : '已读取';
}

function openUrl(url: string) {
  void Linking.openURL(url).catch(() => {});
}

function ResultRow({ result }: { result: WebSearchResult }) {
  const theme = useNativeTheme();
  return (
    <Pressable accessibilityRole="link" onPress={() => openUrl(result.url)} style={({ pressed }) => [styles.resultRow, { opacity: pressed ? 0.6 : 1 }]}>
      <Ionicons name="globe-outline" size={15} color={theme.colors.mutedForeground} />
      <View style={styles.resultCopy}>
        <Text numberOfLines={2} style={[styles.resultTitle, { color: theme.colors.foreground }]}>{result.title}</Text>
        <Text numberOfLines={1} style={[styles.resultDomain, { color: theme.colors.mutedForeground }]}>{result.domain || hostname(result.url)}</Text>
      </View>
    </Pressable>
  );
}

export function WebActivityRow({ activity }: { activity: WebActivity }) {
  const theme = useNativeTheme();
  const [open, setOpen] = useState(activity.status === 'running');
  const running = activity.status === 'running';
  const failed = activity.status === 'error';
  const urls = activity.kind === 'fetch' ? activity.urls ?? (activity.url ? [activity.url] : []) : [];
  return (
    <View style={[styles.activity, { borderColor: theme.colors.border, borderRadius: Math.min(theme.radius, 10) }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.activityToggle}>
        <Ionicons name={failed ? 'alert-circle-outline' : activity.kind === 'search' ? 'search-outline' : 'document-text-outline'} size={16} color={theme.colors.mutedForeground} />
        <Text style={[styles.activityLabel, { color: theme.colors.foreground }]}>{activity.kind === 'search' ? '搜索资料' : '读取网页'}</Text>
        <Text style={[styles.activityState, { color: failed ? theme.colors.destructive : theme.colors.mutedForeground }]}>{activityLabel(activity)}</Text>
        {activity.tookMs !== undefined && !running ? <Text style={[styles.activityState, { color: theme.colors.mutedForeground }]}>{formatTook(activity.tookMs)}</Text> : null}
        <Ionicons name={open ? 'chevron-up' : 'chevron-forward'} size={14} color={theme.colors.mutedForeground} />
      </Pressable>
      {open ? (
        <View style={styles.activityBody}>
          {activity.kind === 'search' && activity.query ? <Text style={[styles.activityText, { color: theme.colors.mutedForeground }]}>{activity.query}</Text> : null}
          {activity.kind === 'search' ? activity.results?.map((result) => <ResultRow key={`${result.rank}:${result.url}`} result={result} />) : null}
          {activity.kind === 'search' && activity.status === 'complete' && !activity.results?.length
            ? <Text style={[styles.activityText, { color: theme.colors.mutedForeground }]}>本次检索未找到可用结果。</Text> : null}
          {urls.map((url) => (
            <Pressable key={url} accessibilityRole="link" onPress={() => openUrl(url)} style={styles.resultRow}>
              <Ionicons name="globe-outline" size={15} color={theme.colors.mutedForeground} />
              <View style={styles.resultCopy}>
                <Text numberOfLines={1} style={[styles.resultTitle, { color: theme.colors.foreground }]}>{url === activity.url ? activity.title || hostname(url) : hostname(url)}</Text>
                <Text numberOfLines={1} style={[styles.resultDomain, { color: theme.colors.mutedForeground }]}>{url}</Text>
              </View>
            </Pressable>
          ))}
          {activity.error ? <Text style={[styles.activityText, { color: failed ? theme.colors.destructive : theme.colors.mutedForeground }]}>{activity.error}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

/** The single status row above a reply, shared by waiting, reasoning and tool calls. */
export function ReasoningBlock({ reasoning = '', state, elapsedMs = null, startedAt = null, activities, process }: {
  reasoning?: string;
  state: ReasoningState;
  elapsedMs?: number | null;
  startedAt?: number | null;
  activities?: WebActivity[];
  process?: ProcessActivity[];
}) {
  const theme = useNativeTheme();
  const [open, setOpen] = useState(false);
  const running = state === 'running';
  const text = reasoning.trim();
  const steps: ProcessActivity[] = process?.length ? process : [
    ...(text ? [{ id: 'legacy-thinking', kind: 'thinking' as const, content: text, status: 'complete' as const }] : []),
    ...(activities ?? []),
  ];
  const visibleSteps = steps.filter((step) => step.kind !== 'thinking' || step.content.trim());
  const live = running && startedAt !== null;
  const seconds = useElapsed(live ? startedAt : null);
  const elapsed = live ? Math.max(seconds, Math.floor((elapsedMs ?? 0) / 1000)) : Math.floor((elapsedMs ?? 0) / 1000);
  const showElapsed = elapsedMs !== null || startedAt !== null;
  const icon = state === 'stopped' ? 'stop-circle-outline' : state === 'error' ? 'alert-circle-outline' : running ? 'sparkles-outline' : 'checkmark-circle-outline';
  return (
    <View style={[styles.reasoning, { borderColor: theme.colors.border, borderRadius: Math.min(theme.radius, 10) }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.reasoningToggle}>
        <Ionicons name={icon} size={17} color={running ? theme.colors.primary : theme.colors.mutedForeground} />
        <Text style={[styles.reasoningLabel, { color: theme.colors.foreground }]}>思考过程</Text>
        {showElapsed ? <Text style={[styles.reasoningTime, { color: theme.colors.mutedForeground }]}>{formatElapsed(elapsed)}</Text> : null}
        <Ionicons name={open ? 'chevron-up' : 'chevron-forward'} size={15} color={theme.colors.mutedForeground} />
      </Pressable>
      {open && visibleSteps.length ? (
        <View style={styles.reasoningBody}>
          {visibleSteps.map((step) => step.kind === 'thinking'
            ? <MessageContent key={step.id} content={step.content} streaming={running && step.status === 'running'} />
            : <WebActivityRow key={step.id} activity={step} />)}
        </View>
      ) : null}
    </View>
  );
}

function ImagePreview({ image, onClose }: { image: { dataUrl: string; name: string }; onClose: () => void }) {
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.previewBackdrop}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel="关闭图片预览" onPress={onClose} />
        <Image source={{ uri: image.dataUrl }} resizeMode="contain" style={styles.previewImage} accessibilityLabel={image.name} />
        <Text numberOfLines={1} style={styles.previewName}>{image.name}</Text>
      </View>
    </Modal>
  );
}

function SentImages({ images }: { images: NonNullable<Message['images']> }) {
  const theme = useNativeTheme();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = images.find((image) => image.id === previewId);
  return (
    <>
      <View style={styles.images}>
        {images.map((image) => (
          <Pressable key={image.id} accessibilityRole="imagebutton" accessibilityLabel={`预览图片 ${image.name}`} onPress={() => setPreviewId(image.id)}>
            <Image source={{ uri: image.dataUrl }} style={[styles.sentImage, { borderColor: theme.colors.border }]} />
          </Pressable>
        ))}
      </View>
      {preview ? <ImagePreview image={preview} onClose={() => setPreviewId(null)} /> : null}
    </>
  );
}

function MessageActions({ message, onFork, onFeedback }: {
  message: Message;
  onFork?: () => void;
  onFeedback?: (feedback?: MessageFeedback) => void;
}) {
  const theme = useNativeTheme();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  type Action = { key: string; icon: ComponentProps<typeof Ionicons>['name']; label: string; onPress: () => void; disabled?: boolean };
  const actions: Action[] = [
    { key: 'copy', icon: copied ? 'checkmark-outline' : 'copy-outline', label: '复制消息', onPress: () => { void Clipboard.setStringAsync(getCopyText(message)).then(() => setCopied(true)).catch(() => {}); } },
    ...(message.role === 'assistant' ? [
      { key: 'good', icon: message.feedback === 'good' ? 'thumbs-up' : 'thumbs-up-outline', label: '赞', onPress: () => onFeedback?.(message.feedback === 'good' ? undefined : 'good'), disabled: !onFeedback },
      { key: 'bad', icon: message.feedback === 'bad' ? 'thumbs-down' : 'thumbs-down-outline', label: '踩', onPress: () => onFeedback?.(message.feedback === 'bad' ? undefined : 'bad'), disabled: !onFeedback },
      { key: 'fork', icon: 'git-branch-outline', label: '从此处创建分支对话', onPress: () => onFork?.(), disabled: !onFork },
    ] as Action[] : []),
  ];
  return (
    <View style={styles.actions}>
      {actions.map((action) => (
        <Pressable key={action.key} accessibilityRole="button" accessibilityLabel={action.label}
          hitSlop={8} disabled={action.disabled}
          onPress={action.onPress} style={({ pressed }) => [styles.actionButton, { opacity: pressed ? 0.5 : 1 }]}>
          <Ionicons name={action.icon} size={17} color={theme.colors.mutedForeground} />
        </Pressable>
      ))}
    </View>
  );
}

function ReplyStatus({ message, onRetry }: { message: Message; onRetry?: () => void }) {
  const theme = useNativeTheme();
  if (message.status === 'stopped') return <Text style={[styles.replyStatus, { color: theme.colors.mutedForeground }]}>{message.error ?? '已停止生成'}</Text>;
  if (message.status === 'error') {
    return (
      <View style={styles.failure}>
        <Text style={[styles.replyStatus, { color: theme.colors.destructive }]}>{message.error ?? '回复未完成，已生成内容已保留。'}</Text>
        {onRetry ? (
          <Pressable accessibilityRole="button" onPress={onRetry} style={styles.retry}>
            <Ionicons name="refresh" size={14} color={theme.colors.primary} />
            <Text style={[styles.retryLabel, { color: theme.colors.primary }]}>重试</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  if (message.status === 'complete' && message.error) return <Text style={[styles.replyStatus, { color: theme.colors.mutedForeground }]}>{message.error}</Text>;
  return null;
}

type MessageItemProps = {
  message: Message;
  pending?: boolean;
  onRetry?: () => void;
  onFeedback?: (feedback?: MessageFeedback) => void;
  onFork?: () => void;
  liveStartedAt?: number | null;
};

export const MessageItem = memo(function MessageItem({ message, pending, onRetry, onFeedback, onFork, liveStartedAt = null }: MessageItemProps) {
  const theme = useNativeTheme();
  const live = message.status === 'streaming';
  const showReasoning = message.role === 'assistant' && (!!message.reasoning?.trim() || !!message.activities?.length || !!message.process?.length || (live && !message.content.trim()));
  if (message.role === 'user') {
    return (
      <View style={[styles.message, styles.userMessage]}>
        {message.images?.length ? <SentImages images={message.images} /> : null}
        {(message.quote || message.content.trim()) ? (
          <View style={[styles.userBubble, { backgroundColor: theme.colors.secondary, borderRadius: Math.min(theme.radius + 6, 20) }]}>
            {message.quote ? (
              <View style={[styles.quote, { borderLeftColor: theme.colors.primary }]}>
                <Text selectable style={[styles.quoteText, { color: theme.colors.mutedForeground }]}>{message.quote}</Text>
              </View>
            ) : null}
            {message.content.trim() ? <Text selectable style={[styles.userText, { color: theme.colors.secondaryForeground }]}>{message.content}</Text> : null}
          </View>
        ) : null}
        {pending ? <Text style={[styles.pendingLabel, { color: theme.colors.mutedForeground }]}>等待发送</Text>
          : <MessageActions message={message} />}
      </View>
    );
  }
  return (
    <View style={styles.message}>
      {showReasoning ? <ReasoningBlock reasoning={message.reasoning} activities={message.activities} process={message.process}
        state={getReasoningState(message)} elapsedMs={message.thinkingMs ?? null} startedAt={live ? liveStartedAt : null} /> : null}
      <MessageContent content={message.content} streaming={live} />
      <ReplyStatus message={message} onRetry={onRetry} />
      {!live && message.content.trim() ? <MessageActions message={message} onFeedback={onFeedback} onFork={onFork} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  message: { paddingHorizontal: 18, paddingVertical: 8, gap: 8 },
  userMessage: { alignItems: 'flex-end' },
  userBubble: { maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  userText: { fontSize: 16, lineHeight: 24 },
  quote: { borderLeftWidth: 3, paddingLeft: 10 },
  quoteText: { fontSize: 13, lineHeight: 19 },
  pendingLabel: { fontSize: 11, paddingHorizontal: 4 },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', maxWidth: '88%' },
  sentImage: { width: 120, height: 120, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  reasoning: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  reasoningToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  reasoningLabel: { fontSize: 13.5, fontWeight: '600' },
  reasoningTime: { fontSize: 12, marginLeft: 'auto' },
  reasoningBody: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  activity: { borderWidth: StyleSheet.hairlineWidth },
  activityToggle: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 9 },
  activityLabel: { fontSize: 13 },
  activityState: { fontSize: 11 },
  activityBody: { paddingHorizontal: 10, paddingBottom: 10, gap: 6 },
  activityText: { fontSize: 13, lineHeight: 19 },
  resultRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, paddingVertical: 3 },
  resultCopy: { flex: 1, gap: 1 },
  resultTitle: { fontSize: 13, lineHeight: 18 },
  resultDomain: { fontSize: 11 },
  actions: { flexDirection: 'row', gap: 2 },
  actionButton: { width: 32, height: 30, alignItems: 'center', justifyContent: 'center' },
  replyStatus: { fontSize: 13, lineHeight: 19 },
  failure: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  retryLabel: { fontSize: 13, fontWeight: '600' },
  previewBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12 },
  previewImage: { width: '100%', height: '80%' },
  previewName: { color: '#ffffff', fontSize: 13, paddingHorizontal: 16 },
});
