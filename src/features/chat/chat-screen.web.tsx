import { useRef, useState } from 'react';

import { Icon } from '@/components/web/icon';
import { Dialog } from '@/components/web/dialog';
import { useChat, type MessageImage } from './chat-state';
import { Composer } from './components/composer.web';
import { ConversationTitle } from './components/conversation-title.web';
import { ScrollToBottomButton, useChatAutoScroll } from './components/scroll-to-bottom.web';
import { useDrafts } from './draft-state';
import { MessageContent } from './components/message-content.web';
import { MessageActions } from './components/message-actions.web';
import { ReasoningBlock, getReasoningState } from './components/reasoning-block.web';
import { useChatRuntime } from './chat-runtime';
import { Link, router, type Href } from 'expo-router';
import { useIsPreview } from '@/features/workspace/preview-context';
import { conversationHref } from './conversation-href';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useSettingsRoot } from '@/features/settings/settings-page.web';
import { SelectionQuote } from './components/selection-quote.web';
import { QuoteCard } from './components/quote-card.web';
import { ConversationNavigator } from './components/conversation-navigator.web';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export default function ChatScreen() {
  const { conversations, activeId, sidebarOpen, lastThinkingEffort, dispatch } = useChat();
  const { drafts, setDraft, quotes, setQuote } = useDrafts();
  const runtime = useChatRuntime();
  const preview = useIsPreview();
  const settingsHref: Href = `${useSettingsRoot()}/models`;
  const conversation = conversations.find((item) => item.id === activeId);
  const thinkingEffort = conversation?.thinkingEffort ?? lastThinkingEffort;
  const lastMessage = conversation?.messages.at(-1);
  const failedReply = lastMessage?.role === 'assistant' && lastMessage.status === 'error' ? lastMessage : null;
  // One indicator for the whole wait, instead of separate copy for "request sent" and "no token yet".
  // Until the reply message exists the line lives outside the list; once it does, the reply renders
  // the same line itself, so the two never show together.
  const generating = runtime.runningId !== null && runtime.runningId === activeId;
  const liveReply = lastMessage?.role === 'assistant' ? lastMessage : null;
  const awaitingReply = runtime.runningId === conversation?.id && !liveReply;
  const liveStartedAt = runtime.runningId === conversation?.id ? runtime.startedAt : null;
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
  const { scrollToBottom, scrollToMessage, visible: scrollToBottomVisible } = useChatAutoScroll({
    containerRef: messageScroller,
    containerKey: activeId ?? 'new',
    followKey: `${messages.length}:${latestContent?.length ?? 0}:${latestReasoning?.length ?? 0}`,
  });
  function changeDraft(value: string) { setDraft(draftKey, value); }
  function send(images: MessageImage[]) {
    const content = draft.trim();
    if (!content && !images.length && !quote.trim()) return false;
    const conversationId = activeId ?? createId();
    const sent = runtime.send(content, conversationId, thinkingEffort, images, quote);
    if (sent) {
      setDraft(draftKey, '');
      setQuote(draftKey, '');
      if (!activeId) router.replace(conversationHref(conversationId, preview));
    }
    return sent;
  }
  function updateThinkingEffort(value: typeof thinkingEffort) {
    dispatch({ type: 'thinking-effort', conversationId: conversation?.id ?? null, thinkingEffort: value });
  }

  return <div className="chat-screen"><main ref={messageScroller} className={`chat-main ${hasMessages ? 'has-messages' : 'is-empty'}`} id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      {!sidebarOpen && <button className="sidebar-expand" type="button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}><Icon name="sidebar" size={22} /></button>}
      {conversation && <ConversationTitle key={conversation.id} title={conversation.title}
        onRename={(title) => dispatch({ type: 'rename', id: conversation.id, title })} />}
    </header>
    {runtime.error && <Dialog title="操作失败" className="compact-dialog" onClose={runtime.clearError}>
      <p className="dialog-description" role="alert">{runtime.error}</p>
      <footer className="dialog-footer">
        <Link href={settingsHref} asChild><LinkAnchor className="secondary-button" onClick={runtime.clearError}>配置模型</LinkAnchor></Link>
        <button type="button" className="secondary-button" onClick={runtime.clearError}>知道了</button>
      </footer>
    </Dialog>}
    {runtime.runningId && runtime.runningId !== activeId && <div className="chat-runtime-notice" role="status"><span>另一个对话正在生成回复。</span><button onClick={runtime.stop}>停止生成</button></div>}
    {hasMessages ? <>
      <div className="messages-scroll">
        <div className="messages-content">
          {messages.map((message) => {
            if (message.role === 'assistant' && message.status === 'error' && !message.content.trim() && !message.reasoning?.trim()) {
              return null;
            }
            const live = message.id === liveReply?.id;
            // A live reply shows the disclosure before reasoning arrives, so it can be opened
            // while the response is still warming up. Once prose starts without reasoning the
            // line has nothing to reveal and disappears.
            const showReasoning = !!message.reasoning?.trim()
              || (live && message.status === 'streaming' && !message.content.trim());
            return message.role === 'user'
              ? <article className="user-message" key={message.id} data-user-message-id={message.id} aria-label="你的消息">
                <div className={`user-message-content${message.images?.length ? ' has-images' : ''}`}>
                  {message.quote && <QuoteCard content={message.quote} />}
                  {!!message.images?.length && <div className="user-message-images">{message.images.map((image) => <img key={image.id} src={image.dataUrl} alt={image.name} />)}</div>}
                  {message.content.trim() ? <MessageContent content={message.content} /> : null}
                </div>
                <MessageActions message={message} />
              </article>
              : <article className="assistant-message" key={message.id} aria-label="助手回复">
              {showReasoning && <ReasoningBlock reasoning={message.reasoning} state={getReasoningState(message)} elapsedMs={message.thinkingMs ?? null} startedAt={live && message.status === 'streaming' ? liveStartedAt : null} runningLabel={thinkingEffort === 'default' ? '生成中' : '思考中'} open={live ? liveReasoningOpen : undefined} onOpenChange={live ? setLiveReasoningOpen : undefined} />}
              <div data-quote-source><MessageContent content={message.content} streaming={message.status === 'streaming'} /></div>
              {message.status === 'complete' && message.error && <p className="reply-status" role="status">{message.error}</p>}
              {message.status === 'stopped' && <p className="reply-status">已停止生成</p>}
              {message.status !== 'streaming' && message.content.trim() && <MessageActions message={message}
                onFeedback={(feedback) => dispatch({ type: 'feedback', conversationId: conversation.id, messageId: message.id, feedback })} onFork={() => {
                const forkId = createId();
                dispatch({ type: 'fork', conversationId: conversation.id, messageId: message.id, forkId, updatedAt: Date.now() });
                router.push(conversationHref(forkId, preview));
              }} />}
              {message.status === 'stopped' && message.id === lastMessage?.id && <button className="secondary-button" disabled={runtime.runningId !== null} onClick={() => runtime.retry(conversation.id, thinkingEffort)}>重新生成</button>}
            </article>;
          })}
          {failedReply && runtime.runningId !== conversation.id && <div>
            <button className="secondary-button reply-error-retry" type="button" disabled={runtime.runningId !== null} onClick={() => runtime.retry(conversation.id, thinkingEffort)}><Icon name="refresh" size={15} />重新生成</button>
          </div>}
          {awaitingReply && <ReasoningBlock state="running" startedAt={liveStartedAt} runningLabel={thinkingEffort === 'default' ? '生成中' : '思考中'} open={liveReasoningOpen} onOpenChange={setLiveReasoningOpen} />}
          {!runtime.runningId && lastMessage?.role === 'user' && <button className="secondary-button" onClick={() => runtime.retry(conversation.id, thinkingEffort)}>生成回复</button>}
        </div>
      </div>
      <div className="bottom-composer">
        <ScrollToBottomButton generating={generating} visible={scrollToBottomVisible} onScrollToBottom={scrollToBottom} />
        <Composer key={draftKey} value={draft} onChange={changeDraft} onSend={send} thinkingEffort={thinkingEffort} onThinkingEffortChange={updateThinkingEffort} quote={quote} onRemoveQuote={() => setQuote(draftKey, '')} />
      </div>
    </> : <div className="welcome-scroll"><div className="welcome-content">
      <div className="welcome-heading"><h1>Matrius</h1></div>
      <Composer key={draftKey} value={draft} onChange={changeDraft} onSend={send} thinkingEffort={thinkingEffort} onThinkingEffortChange={updateThinkingEffort} quote={quote} onRemoveQuote={() => setQuote(draftKey, '')} />
    </div></div>}
  </main>
    {hasMessages && <SelectionQuote key={`selection-${draftKey}`} containerRef={messageScroller} onQuote={(content) => {
      setQuote(draftKey, content);
      scrollToBottom();
      messageScroller.current?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus({ preventScroll: true });
    }} />}
    {hasMessages && <ConversationNavigator key={`navigator-${draftKey}`} messages={messages} containerRef={messageScroller} onNavigate={scrollToMessage} />}
  </div>;
}
