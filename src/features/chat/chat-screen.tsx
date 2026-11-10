import { useMobile } from '@/components/web/use-mobile';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { Icon } from '@/components/web/icon';
import { BrandMark } from '@/components/web/brand-mark';
import type { MessageFile } from '@agent/core/types';
import { buildSystemPrompt } from '@agent/core/system-prompt';
import { createFileTool, fileToolsSystemPrompt } from '@agent/core/file-tools';
import { createWebTools, webToolsSystemPrompt } from '@agent/core/web-tools';
import { useChat, type Message, type MessageImage } from './chat-state';
import { Composer } from './components/composer';
import { ContextMeter } from './components/context-meter';
import { measureContextUsage } from './context-usage';
import { ConversationTitle } from './components/conversation-title';
import { ScrollToBottomButton, useChatAutoScroll } from './components/scroll-to-bottom';
import { useDrafts } from './draft-state';
import { AssistantAnswer } from '@/features/copilot/ui-artifacts';
import { MessageAttachments } from './components/message-attachments';
import { GeneratedFiles } from './components/generated-files';
import { CollapsibleMessageContent } from './components/collapsible-message-content';
import { MessageActions } from './components/message-actions';
import { ReasoningBlock, getReasoningState } from './components/reasoning-block';
import { ReplyStatus } from './components/reply-status';
import { useChatRuntime } from './chat-runtime';
import { useModels } from '@/features/models/model-state';
import { usePersonalization } from '@/features/settings/personalization-state';
import { useMemory } from '@/features/memory/memory-state';
import { useNetworkTools } from '@/features/instance/network-tools-state';
import { useInstance, useFeature } from '@/features/instance/instance-state';
import { router } from '@/router';
import { useIsPreview } from '@/features/workspace/preview-context';
import { conversationHref } from './conversation-href';
import { ChatNotice, type ChatNoticeItem } from './components/chat-notice';
import { SelectionQuote } from './components/selection-quote';
import { QuoteCard } from './components/quote-card';
import { ConversationNavigator } from './components/conversation-navigator';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

const RUNTIME_NOTICE_ID = 'runtime-error';
const NO_MESSAGES: Message[] = [];

function UserMessage({ message, pending = false }: { message: Message; pending?: boolean }) {
  return <article className="user-message" data-user-message-id={pending ? undefined : message.id}
    data-steering={message.steering ? 'true' : undefined} data-pending={pending ? 'true' : undefined}
    aria-label={pending ? '等待发送的消息' : message.steering ? '你的补充消息' : '你的消息'}>
    {!!(message.images?.length || message.files?.length || message.fileIds?.length) && <MessageAttachments
      images={message.images} files={message.files} fileIds={message.fileIds} />}
    {(message.quote || message.content.trim()) && <div className="user-message-content">
      {message.quote && <QuoteCard content={message.quote} />}
      {message.content.trim() ? <CollapsibleMessageContent content={message.content} /> : null}
    </div>}
    {pending ? null : <MessageActions message={message} />}
  </article>;
}

export default function ChatScreen() {
  const mobile = useMobile();
  const { conversations, activeId, sidebarOpen, dispatch } = useChat();
  const { drafts, setDraft, quotes, setQuote } = useDrafts();
  const runtime = useChatRuntime();
  const models = useModels();
  const { preferences } = usePersonalization();
  const memory = useMemory();
  const networkTools = useNetworkTools();
  const filesEnabled = useFeature('files');
  const uiEnabled = useFeature('generative-ui');
  const instance = useInstance();
  const preview = useIsPreview();
  const [notices, setNotices] = useState<ChatNoticeItem[]>([]);
  const conversation = conversations.find((item) => item.id === activeId);
  // Each conversation remembers its model. Restoring it once per switch keeps the picker in
  // sync with what the next request will use, while a model change inside a conversation
  // is bound back through the composer callback instead of this effect.
  const restoredFor = useRef<string | null | undefined>(undefined);
  // The effort follows the model: switching models shows the depth that model last used.
  const thinkingEffort = models.selected?.thinkingEffort ?? 'low';
  const lastMessage = conversation?.messages.at(-1);
  // One indicator for the whole wait, instead of separate copy for "request sent" and "no token yet".
  // Until the reply message exists the line lives outside the list; once it does, the reply renders
  // the same line itself, so the two never show together.
  const conversationRun = activeId ? runtime.runs[activeId] : undefined;
  const generating = !!conversationRun;
  const liveReply = lastMessage?.role === 'assistant' ? lastMessage : null;
  const awaitingReply = generating && !liveReply;
  const liveStartedAt = conversationRun?.startedAt ?? null;
  // Keep each disclosure independent through completion, new replies and conversation switches.
  const [reasoningOpen, setReasoningOpen] = useState<Record<string, boolean>>({});
  const messages = conversation?.messages ?? NO_MESSAGES;
  // Mirror chat-runtime's prompt assembly so the meter counts the tool instructions the next
  // request actually carries. The counts are estimates; the provider remains the authority.
  const systemPrompt = useMemo(() => [
    buildSystemPrompt(preferences, memory),
    networkTools.ready && networkTools.enabled ? webToolsSystemPrompt() : '',
    filesEnabled ? fileToolsSystemPrompt() : '',
  ].filter(Boolean).join('\n\n'), [preferences, memory, networkTools.ready, networkTools.enabled, filesEnabled]);
  const contextUsage = useMemo(() => {
    if (!models.selected) return null;
    const tools = networkTools.ready && networkTools.enabled ? createWebTools(instance.request) : [];
    if (filesEnabled) tools.push(createFileTool({ request: instance.request, conversationId: activeId ?? undefined,
      availableFiles: messages.flatMap((message) => message.files ?? []).slice(-30) }).tool);
    const latest = activeId ? runtime.contexts?.[activeId] : undefined;
    return measureContextUsage(messages, systemPrompt, models.selected, {
      tools, summary: conversation?.contextSummary,
      latestCall: latest?.modelId === models.selected.id && latest.contextWindow === models.selected.contextWindow ? latest : undefined,
    });
  }, [messages, models.selected, systemPrompt, networkTools.ready, networkTools.enabled, instance.request, filesEnabled, activeId, runtime.contexts, conversation?.contextSummary]);
  // Messages sent after the answer text started: shown here until this run ends, then saved.
  const pending = runtime.pendingMessages(activeId);
  const draftKey = activeId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const quote = quotes[draftKey] ?? '';
  const messageScroller = useRef<HTMLElement>(null);
  const hasMessages = !!conversation?.messages.length;
  const latestContent = conversation?.messages.at(-1)?.content;
  const latestReasoning = conversation?.messages.at(-1)?.reasoning;
  const latestActivities = conversation?.messages.at(-1)?.activities?.length ?? 0;
  const { scrollToBottom, scrollToMessage, followLatest, visible: scrollToBottomVisible } = useChatAutoScroll({
    containerRef: messageScroller,
    containerKey: `${draftKey}-${mobile}-${hasMessages}`,
    followKey: `${messages.length}:${latestContent?.length ?? 0}:${latestReasoning?.length ?? 0}:${latestActivities}`,
    scrollKey: activeId,
  });
  function changeDraft(value: string) { setDraft(draftKey, value); }
  // The composer is keyed by conversation, so a pending model switch can only bind the
  // conversation whose picker started it.
  function bindModel(modelId: string) {
    if (activeId) dispatch({ type: 'bind-model', conversationId: activeId, modelId });
  }
  // Notices stack so separate failures stay readable instead of overwriting each other.
  function showNotice(message: string | null) {
    runtime.clearError();
    if (!message) { setNotices([]); return; }
    setNotices((current) => [...current, { id: createId(), message }]);
  }
  function dismissNotice(id: string) {
    if (id === RUNTIME_NOTICE_ID) { runtime.clearError(); return; }
    setNotices((current) => current.filter((item) => item.id !== id));
  }
  const noticeItems = runtime.error
    ? [{ id: RUNTIME_NOTICE_ID, message: runtime.error }, ...notices]
    : notices;
  // Settings and other full-page routes unmount this screen while a run may still be going;
  // completion must stay unread in that case even though activeId did not change.
  useEffect(() => {
    dispatch({ type: 'visible', value: true });
    return () => dispatch({ type: 'visible', value: false });
  }, [dispatch]);
  useEffect(() => {
    if (!models.ready) return;
    const id = conversation?.id ?? null;
    if (restoredFor.current === id) return;
    restoredFor.current = id;
    const bound = conversation?.modelId;
    if (!bound || bound === models.selectedId || !models.models.some((model) => model.id === bound)) return;
    void models.select(bound).catch(() => showNotice('恢复该对话的模型失败，请重试。'));
    // showNotice only sets state; depending on it would re-run this once-per-switch restore.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation, models]);
  function send(images: MessageImage[], files: MessageFile[] = []) {
    const content = draft.trim();
    if (!content && !images.length && !files.length && !quote.trim()) return false;
    const conversationId = activeId ?? createId();
    // Thinking/tool phases take the message as a correction; after the answer text starts it
    // is deferred to a new turn; otherwise this starts an ordinary new run.
    const outcome = runtime.steer(content, conversationId, images, quote, files);
    const sent = outcome === false ? runtime.send(content, conversationId, images, quote, files) : true;
    if (sent) {
      setDraft(draftKey, '');
      setQuote(draftKey, '');
      if (outcome === 'deferred') showNotice('回复已开始，这条消息将在本轮结束后发送。');
      // Sending is an explicit request to see the conversation continue, so bring
      // the reader back even when they had scrolled up to read older messages.
      followLatest();
      if (!activeId) router.replace(conversationHref(conversationId, preview));
    }
    return sent;
  }
  function updateThinkingEffort(value: typeof thinkingEffort) {
    if (!models.selected) return;
    void models.setThinkingEffort(models.selected.id, value).catch(() => showNotice('保存思考强度失败，请重试。'));
  }

  return <div className="chat-screen"><main ref={mobile && hasMessages ? undefined : messageScroller} data-conversation-key={`${draftKey}-${mobile}-${hasMessages}`} className={`chat-main ${hasMessages ? 'has-messages' : 'is-empty'}`} id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      {!sidebarOpen && <button className="sidebar-expand" type="button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}><Icon name="sidebar" size={22} /></button>}
      {conversation && <ConversationTitle key={conversation.id} title={conversation.title}
        onRename={(title) => dispatch({ type: 'rename', id: conversation.id, title })} />}
    </header>
    {hasMessages ? <>
      <div className="messages-scroll" data-conversation-key={`${draftKey}-${mobile}-${hasMessages}`} ref={mobile ? (element) => { messageScroller.current = element; } : undefined}>
        <div className="messages-content">
          {messages.map((message) => {
            const live = message.id === liveReply?.id;
            // Preserve an explicitly opened waiting disclosure even if the model only emits prose.
            const showReasoning = !!message.reasoning?.trim() || !!message.activities?.length || !!message.process?.length
              || reasoningOpen[message.id] === true
              || (live && message.status === 'streaming' && !message.content.trim());
            const block = message.role === 'user'
              ? <UserMessage key={message.id} message={message} />
              : <article className="assistant-message" key={message.id} aria-label="助手回复">
              {showReasoning && <ReasoningBlock reasoning={message.reasoning} activities={message.activities} process={message.process} state={getReasoningState(message)} elapsedMs={message.thinkingMs ?? null} startedAt={live && message.status === 'streaming' ? liveStartedAt : null} open={reasoningOpen[message.id] ?? false} onOpenChange={(open) => setReasoningOpen((current) => ({ ...current, [message.id]: open }))} />}
              <AssistantAnswer content={message.content} streaming={message.status === 'streaming'} artifacts={uiEnabled ? message.uiArtifacts : undefined} onPrompt={generating ? undefined : (text) => { runtime.send(text, conversation.id); }} />
              <ReplyStatus message={message} onRetry={message.status === 'error' && message.id === lastMessage?.id && !generating
                ? () => runtime.retry(conversation.id) : undefined} />
              {/* Saved files wait for the reply to finish, so the answer is not pushed down mid-stream. */}
              {message.status !== 'streaming' && !!message.files?.length && <GeneratedFiles files={message.files} />}
              {message.status !== 'streaming' && message.content.trim() && <MessageActions message={message}
                onFeedback={(feedback) => dispatch({ type: 'feedback', conversationId: conversation.id, messageId: message.id, feedback })} onFork={() => {
                const forkId = createId();
                dispatch({ type: 'fork', conversationId: conversation.id, messageId: message.id, forkId, updatedAt: Date.now() });
                router.push(conversationHref(forkId, preview));
              }} />}
            </article>;
            // A deferred supplement stays under the previous user message, i.e. in front of
            // the reply that is still streaming, until that run ends and saves it below.
            return live && pending.length
              ? <Fragment key={message.id}>{pending.map((item) => <UserMessage key={item.id} message={item} pending />)}{block}</Fragment>
              : block;
          })}
          {!liveReply && pending.map((item) => <UserMessage key={item.id} message={item} pending />)}
          {awaitingReply && conversationRun && <ReasoningBlock state="running" startedAt={liveStartedAt}
            open={reasoningOpen[conversationRun.replyId] ?? false}
            onOpenChange={(open) => setReasoningOpen((current) => ({ ...current, [conversationRun.replyId]: open }))} />}
        </div>
      </div>
      <div className="bottom-composer">
        <div className="bottom-composer-body">
          <Composer key={draftKey} value={draft} onChange={changeDraft} onSend={send} thinkingEffort={thinkingEffort} onThinkingEffortChange={updateThinkingEffort} onModelChange={bindModel} quote={quote} onRemoveQuote={() => setQuote(draftKey, '')} onNotice={showNotice} />
          {!mobile && contextUsage && <div className="composer-meta"><ContextMeter usage={contextUsage} /></div>}
          <ScrollToBottomButton generating={generating} visible={scrollToBottomVisible} onScrollToBottom={scrollToBottom} />
        </div>
      </div>
    </> : <div className="welcome-scroll"><div className="welcome-content">
      <div className="welcome-heading"><BrandMark size={42} className="welcome-mark" /><h1>Matrius</h1></div>
      <Composer key={draftKey} value={draft} onChange={changeDraft} onSend={send} thinkingEffort={thinkingEffort} onThinkingEffortChange={updateThinkingEffort} onModelChange={bindModel} quote={quote} onRemoveQuote={() => setQuote(draftKey, '')} onNotice={showNotice} />
    </div></div>}
  </main>
    <ChatNotice items={noticeItems} onClose={dismissNotice} />
    {hasMessages && <SelectionQuote key={`selection-${draftKey}`} containerRef={messageScroller} onQuote={(content) => {
      setQuote(draftKey, content);
      scrollToBottom();
      messageScroller.current?.closest('.chat-screen')?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus({ preventScroll: true });
    }} />}
    {hasMessages && !mobile && <ConversationNavigator key={`navigator-${draftKey}`} messages={messages} containerRef={messageScroller} onNavigate={scrollToMessage} />}
  </div>;
}
