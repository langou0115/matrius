import { useEffect, useRef, useState } from 'react';

import { Icon } from '@/components/web/icon';
import { useChat, type MessageImage } from './chat-state';
import { Composer } from './components/composer.web';
import { ConversationTitle } from './components/conversation-title.web';
import { ScrollToBottomButton, useChatAutoScroll } from './components/scroll-to-bottom.web';
import { useDrafts } from './draft-state';
import { MessageContent } from './components/message-content.web';
import { MessageAttachments } from './components/message-attachments.web';
import { CollapsibleMessageContent } from './components/collapsible-message-content.web';
import { MessageActions } from './components/message-actions.web';
import { ReasoningBlock, getReasoningState } from './components/reasoning-block.web';
import { useChatRuntime } from './chat-runtime';
import { useModels } from '@/features/models/model-state';
import { router } from 'expo-router';
import { useIsPreview } from '@/features/workspace/preview-context';
import { conversationHref } from './conversation-href';
import { ChatNotice } from './components/chat-notice.web';
import { SelectionQuote } from './components/selection-quote.web';
import { QuoteCard } from './components/quote-card.web';
import { ConversationNavigator } from './components/conversation-navigator.web';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export default function ChatScreen() {
  const { conversations, activeId, sidebarOpen, dispatch } = useChat();
  const { drafts, setDraft, quotes, setQuote } = useDrafts();
  const runtime = useChatRuntime();
  const models = useModels();
  const preview = useIsPreview();
  const [notice, setNotice] = useState<string | null>(null);
  const conversation = conversations.find((item) => item.id === activeId);
  // Each conversation remembers its model. Restoring it once per switch keeps the picker in
  // sync with what the next request will use, while a model change inside a conversation
  // is bound back through the composer callback instead of this effect.
  const restoredFor = useRef<string | null | undefined>(undefined);
  // The effort follows the model: switching models shows the depth that model last used.
  const thinkingEffort = models.selected?.thinkingEffort ?? 'default';
  const lastMessage = conversation?.messages.at(-1);
  const failedReply = lastMessage?.role === 'assistant' && lastMessage.status === 'error' ? lastMessage : null;
  // One indicator for the whole wait, instead of separate copy for "request sent" and "no token yet".
  // Until the reply message exists the line lives outside the list; once it does, the reply renders
  // the same line itself, so the two never show together.
  const conversationRun = activeId ? runtime.runs[activeId] : undefined;
  const generating = !!conversationRun;
  const liveReply = lastMessage?.role === 'assistant' ? lastMessage : null;
  const awaitingReply = generating && !liveReply;
  const liveStartedAt = conversationRun?.startedAt ?? null;
  // Shared by the wait line and the reply's own line so expanding before the first token keeps
  // the reasoning body open when the text starts streaming into it. It also carries across runs:
  // someone who opened the stream once is asking to watch it, not to open it every time.
  const [liveReasoningOpen, setLiveReasoningOpen] = useState(false);
  const messages = conversation?.messages ?? [];
  const draftKey = activeId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const quote = quotes[draftKey] ?? '';
  const messageScroller = useRef<HTMLElement>(null);
  const hasMessages = !!conversation?.messages.length;
  const latestContent = conversation?.messages.at(-1)?.content;
  const latestReasoning = conversation?.messages.at(-1)?.reasoning;
  const { scrollToBottom, scrollToMessage, followLatest, visible: scrollToBottomVisible } = useChatAutoScroll({
    containerRef: messageScroller,
    containerKey: activeId ?? 'new',
    followKey: `${messages.length}:${latestContent?.length ?? 0}:${latestReasoning?.length ?? 0}`,
    scrollKey: activeId,
  });
  function changeDraft(value: string) { setDraft(draftKey, value); }
  // The composer is keyed by conversation, so a pending model switch can only bind the
  // conversation whose picker started it.
  function bindModel(modelId: string) {
    if (activeId) dispatch({ type: 'bind-model', conversationId: activeId, modelId });
  }
  function showNotice(message: string | null) { setNotice(message); runtime.clearError(); }
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
    void models.select(bound).catch(() => setNotice('恢复该对话的模型失败，请重试。'));
  }, [conversation, models]);
  function send(images: MessageImage[]) {
    const content = draft.trim();
    if (!content && !images.length && !quote.trim()) return false;
    const conversationId = activeId ?? createId();
    const sent = runtime.send(content, conversationId, images, quote);
    if (sent) {
      setDraft(draftKey, '');
      setQuote(draftKey, '');
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

  return <div className="chat-screen"><main ref={messageScroller} data-conversation-key={draftKey} className={`chat-main ${hasMessages ? 'has-messages' : 'is-empty'}`} id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      {!sidebarOpen && <button className="sidebar-expand" type="button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}><Icon name="sidebar" size={22} /></button>}
      {conversation && <ConversationTitle key={conversation.id} title={conversation.title}
        onRename={(title) => dispatch({ type: 'rename', id: conversation.id, title })} />}
    </header>
    {hasMessages ? <>
      <div className="messages-scroll">
        <div className="messages-content">
          {messages.map((message) => {
            // A failed request can leave no prose at all. The error still has to be visible
            // here rather than in the workspace-wide notice, which now belongs to this reply.
            if (message.role === 'assistant' && message.status === 'error' && !message.content.trim() && !message.reasoning?.trim()) {
              return <article className="assistant-message" key={message.id} aria-label="助手回复">
                <p className="reply-status" role="alert">{message.error ?? '模型回复失败，请稍后重试。'}</p>
              </article>;
            }
            const live = message.id === liveReply?.id;
            // A live reply shows the disclosure before reasoning arrives, so it can be opened
            // while the response is still warming up. Once prose starts without reasoning the
            // line has nothing to reveal and disappears.
            const showReasoning = !!message.reasoning?.trim()
              || (live && message.status === 'streaming' && !message.content.trim());
            return message.role === 'user'
              ? <article className="user-message" key={message.id} data-user-message-id={message.id} aria-label="你的消息">
                {!!message.images?.length && <MessageAttachments images={message.images} />}
                {(message.quote || message.content.trim()) && <div className="user-message-content">
                  {message.quote && <QuoteCard content={message.quote} />}
                  {message.content.trim() ? <CollapsibleMessageContent content={message.content} /> : null}
                </div>}
                <MessageActions message={message} />
              </article>
              : <article className="assistant-message" key={message.id} aria-label="助手回复">
              {showReasoning && <ReasoningBlock reasoning={message.reasoning} state={getReasoningState(message)} elapsedMs={message.thinkingMs ?? null} startedAt={live && message.status === 'streaming' ? liveStartedAt : null} runningLabel={thinkingEffort === 'default' ? '生成中' : '思考中'} open={live ? liveReasoningOpen : undefined} onOpenChange={live ? setLiveReasoningOpen : undefined} />}
              <div data-quote-source><MessageContent content={message.content} streaming={message.status === 'streaming'} /></div>
              {message.status === 'complete' && message.error && <p className="reply-status" role="status">{message.error}</p>}
              {message.status === 'error' && <p className="reply-status" role="alert">{message.error ?? '模型回复失败，请稍后重试。'}</p>}
              {message.status === 'stopped' && <p className="reply-status">已停止生成</p>}
              {message.status !== 'streaming' && message.content.trim() && <MessageActions message={message}
                onFeedback={(feedback) => dispatch({ type: 'feedback', conversationId: conversation.id, messageId: message.id, feedback })} onFork={() => {
                const forkId = createId();
                dispatch({ type: 'fork', conversationId: conversation.id, messageId: message.id, forkId, updatedAt: Date.now() });
                router.push(conversationHref(forkId, preview));
              }} />}
              {message.status === 'stopped' && message.id === lastMessage?.id && <button className="secondary-button" disabled={generating} onClick={() => runtime.retry(conversation.id)}>重新生成</button>}
            </article>;
          })}
          {failedReply && !generating && <div>
            <button className="secondary-button reply-error-retry" type="button" disabled={generating} onClick={() => runtime.retry(conversation.id)}><Icon name="refresh" size={15} />重新生成</button>
          </div>}
          {awaitingReply && <ReasoningBlock state="running" startedAt={liveStartedAt} runningLabel={thinkingEffort === 'default' ? '生成中' : '思考中'} open={liveReasoningOpen} onOpenChange={setLiveReasoningOpen} />}
          {!generating && lastMessage?.role === 'user' && <button className="secondary-button" onClick={() => runtime.retry(conversation.id)}>生成回复</button>}
        </div>
      </div>
      <div className="bottom-composer">
        <ScrollToBottomButton generating={generating} visible={scrollToBottomVisible} onScrollToBottom={scrollToBottom} />
        <Composer key={draftKey} value={draft} onChange={changeDraft} onSend={send} thinkingEffort={thinkingEffort} onThinkingEffortChange={updateThinkingEffort} onModelChange={bindModel} quote={quote} onRemoveQuote={() => setQuote(draftKey, '')} onNotice={showNotice} />
      </div>
    </> : <div className="welcome-scroll"><div className="welcome-content">
      <div className="welcome-heading"><h1>Matrius</h1></div>
      <Composer key={draftKey} value={draft} onChange={changeDraft} onSend={send} thinkingEffort={thinkingEffort} onThinkingEffortChange={updateThinkingEffort} onModelChange={bindModel} quote={quote} onRemoveQuote={() => setQuote(draftKey, '')} onNotice={showNotice} />
    </div></div>}
  </main>
    <ChatNotice message={runtime.error ?? notice} onClose={() => showNotice(null)} />
    {hasMessages && <SelectionQuote key={`selection-${draftKey}`} containerRef={messageScroller} onQuote={(content) => {
      setQuote(draftKey, content);
      scrollToBottom();
      messageScroller.current?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus({ preventScroll: true });
    }} />}
    {hasMessages && <ConversationNavigator key={`navigator-${draftKey}`} messages={messages} containerRef={messageScroller} onNavigate={scrollToMessage} />}
  </div>;
}
