import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/native/screen';
import { useModels } from '@/features/models/model-state';
import { useNativeTheme } from '@/theme/native-theme';
import { useChat, type MessageImage } from '../chat-state';
import { useChatRuntime } from '../chat-runtime';
import { useConversationRouteState } from '../conversation-route-state';
import { useDrafts } from '../draft-state';
import { Composer } from './composer';
import { MessageItem, ReasoningBlock } from './message';
import { Sidebar } from './sidebar';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export function ChatScreen({ conversationId }: { conversationId: string | null }) {
  const theme = useNativeTheme();
  const { conversations, activeId, dispatch } = useChat();
  const runtime = useChatRuntime();
  const models = useModels();
  const { drafts, setDraft, quotes, setQuote } = useDrafts();
  const { exists } = useConversationRouteState(conversationId);
  const conversation = conversations.find((item) => item.id === activeId);
  const messages = conversation?.messages ?? [];
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scroller = useRef<ScrollView>(null);
  const follow = useRef(true);
  const restoredFor = useRef<string | null | undefined>(undefined);
  const thinkingEffort = models.selected?.thinkingEffort ?? 'default';
  const draftKey = activeId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const quote = quotes[draftKey] ?? '';
  const run = activeId ? runtime.runs[activeId] : undefined;
  const generating = !!run;
  const lastMessage = messages.at(-1);
  const liveReply = lastMessage?.role === 'assistant' ? lastMessage : null;
  const liveStartedAt = conversation && liveReply?.status === 'streaming' ? run?.startedAt ?? null : null;
  const awaitingReply = generating && !liveReply;
  const pending = runtime.pendingMessages(activeId);
  const hasMessages = messages.length > 0;

  function scrollToEnd(animated = false) {
    requestAnimationFrame(() => scroller.current?.scrollToEnd({ animated }));
  }

  // Settings pushes on top of this screen without unmounting it, so visibility follows focus
  // instead of mount: background completions stay unread until the chat is actually shown.
  useFocusEffect(useCallback(() => {
    dispatch({ type: 'visible', value: true });
    return () => dispatch({ type: 'visible', value: false });
  }, [dispatch]));

  // A conversation opens at its newest message, and every switch starts following again.
  useEffect(() => {
    follow.current = true;
    scrollToEnd(false);
  }, [activeId]);

  useEffect(() => {
    if (!conversationId || exists) return;
    router.replace('/');
  }, [conversationId, exists]);

  useEffect(() => {
    if (!models.ready) return;
    const id = conversation?.id ?? null;
    if (restoredFor.current === id) return;
    restoredFor.current = id;
    const bound = conversation?.modelId;
    if (!bound || bound === models.selectedId || !models.models.some((model) => model.id === bound)) return;
    void models.select(bound).catch(() => setNotice('恢复该对话的模型失败，请重试。'));
  }, [conversation, models]);

  useEffect(() => {
    if (!follow.current) return;
    scrollToEnd(true);
  }, [messages.length, lastMessage?.content.length, lastMessage?.reasoning?.length, lastMessage?.activities?.length]);

  function changeDraft(value: string) { setDraft(draftKey, value); }
  function showNotice(message: string | null) { setNotice(message); runtime.clearError(); }

  function bindModel(modelId: string) {
    if (activeId) dispatch({ type: 'bind-model', conversationId: activeId, modelId });
  }

  function updateThinkingEffort(value: typeof thinkingEffort) {
    if (!models.selected) return;
    void models.setThinkingEffort(models.selected.id, value).catch(() => showNotice('保存思考强度失败，请重试。'));
  }

  function send(images: MessageImage[]) {
    const content = draft.trim();
    if (!content && !images.length && !quote.trim()) return false;
    const id = activeId ?? createId();
    const outcome = runtime.steer(content, id, images, quote);
    const sent = outcome === false ? runtime.send(content, id, images, quote) : true;
    if (!sent) return false;
    setDraft(draftKey, '');
    setQuote(draftKey, '');
    if (outcome === 'deferred') setNotice('回复已开始，这条消息将在本轮结束后发送。');
    else showNotice(null);
    follow.current = true;
    scrollToEnd(true);
    if (!activeId) router.replace(`/c/${encodeURIComponent(id)}`);
    return true;
  }

  function newConversation() {
    dispatch({ type: 'select', id: null });
    setSidebarOpen(false);
    router.replace('/');
  }

  function fork(messageId: string, updatedAt: number) {
    if (!conversation) return;
    const forkId = createId();
    dispatch({ type: 'fork', conversationId: conversation.id, messageId, forkId, updatedAt });
    router.push(`/c/${encodeURIComponent(forkId)}`);
  }

  const banner = runtime.error ?? notice;

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="打开侧栏" hitSlop={8} onPress={() => setSidebarOpen(true)} style={styles.headerButton}>
          <Ionicons name="menu" size={24} color={theme.colors.foreground} />
        </Pressable>
        <Text numberOfLines={1} style={[styles.title, { color: theme.colors.foreground }]}>{conversation?.title ?? 'Matrius'}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="新建对话" hitSlop={8} onPress={newConversation} style={styles.headerButton}>
          <Ionicons name="create-outline" size={22} color={theme.colors.foreground} />
        </Pressable>
      </View>

      {banner ? (
        <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" onPress={() => showNotice(null)}
          style={[styles.notice, { backgroundColor: theme.colors.muted, borderColor: theme.colors.border }]}>
          <Ionicons name="information-circle-outline" size={16} color={theme.colors.mutedForeground} />
          <Text style={[styles.noticeText, { color: theme.colors.foreground }]}>{banner}</Text>
          <Ionicons name="close" size={15} color={theme.colors.mutedForeground} />
        </Pressable>
      ) : null}

      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {hasMessages ? (
          <ScrollView
            ref={scroller}
            style={styles.scroll}
            contentContainerStyle={styles.messages}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
              follow.current = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 90;
            }}
            scrollEventThrottle={80}
            onContentSizeChange={() => { if (follow.current) scrollToEnd(false); }}
          >
            {messages.map((message) => {
              const live = message.id === liveReply?.id;
              const item = (
                <MessageItem key={message.id} message={message} liveStartedAt={live ? liveStartedAt : null}
                  onFeedback={(feedback) => { if (conversation) dispatch({ type: 'feedback', conversationId: conversation.id, messageId: message.id, feedback }); }}
                  onFork={message.role === 'assistant' ? () => fork(message.id, Date.now()) : undefined}
                  onRetry={message.status === 'error' && message.id === lastMessage?.id && !generating && conversation
                    ? () => runtime.retry(conversation.id) : undefined} />
              );
              if (!live || !pending.length) return item;
              return (
                <View key={message.id}>
                  {pending.map((pendingMessage) => <MessageItem key={pendingMessage.id} message={pendingMessage} pending />)}
                  {item}
                </View>
              );
            })}
            {!liveReply ? pending.map((pendingMessage) => <MessageItem key={pendingMessage.id} message={pendingMessage} pending />) : null}
            {awaitingReply ? (
              <View style={styles.awaiting}>
                <ReasoningBlock state="running" startedAt={run?.startedAt ?? null} />
              </View>
            ) : null}
          </ScrollView>
        ) : (
          <View style={styles.welcome}>
            <Text style={[styles.welcomeTitle, { color: theme.colors.foreground }]}>Matrius</Text>
          </View>
        )}

        <Composer key={draftKey} value={draft} onChange={changeDraft} onSend={send}
          thinkingEffort={thinkingEffort} onThinkingEffortChange={updateThinkingEffort} onModelChange={bindModel}
          quote={quote} onRemoveQuote={() => setQuote(draftKey, '')} onNotice={showNotice} />
      </KeyboardAvoidingView>

      <Sidebar visible={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 50, paddingHorizontal: 6 },
  headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 14, marginBottom: 4, paddingHorizontal: 12, paddingVertical: 9, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  noticeText: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  body: { flex: 1 },
  scroll: { flex: 1 },
  messages: { paddingTop: 6, paddingBottom: 10 },
  awaiting: { paddingHorizontal: 18, paddingVertical: 8 },
  welcome: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  welcomeTitle: { fontSize: 34, fontWeight: '700', letterSpacing: 0.3 },
});
