import { useEffect, useRef } from 'react';

import { Icon, type IconName } from '@/components/web/icon';
import { useChat } from './chat-state';
import { Composer } from './components/composer.web';
import { ConversationTitle } from './components/conversation-title.web';
import { useDrafts } from './draft-state';
import { MessageContent } from './components/message-content.web';
import { MessageActions } from './components/message-actions.web';
import { useChatRuntime } from './chat-runtime';
import { Link, type Href } from 'expo-router';
import { LinkAnchor } from '@/components/web/link-anchor';
import { useSettingsRoot } from '@/features/settings/settings-page.web';

const suggestions: { icon: IconName; title: string; prompt: string }[] = [
  { icon: 'bolt', title: '解释一个概念', prompt: '用通俗的方式解释一个概念，并举一个具体的例子。' },
  { icon: 'code', title: '帮我看看代码', prompt: '帮我看看接下来这段代码，有哪些可以改进的地方？' },
  { icon: 'pen', title: '润色文字', prompt: '帮我把接下来的文字改得更简洁，保留原意。' },
  { icon: 'compare', title: '做个技术选型', prompt: '帮我比较两个技术方案的适用场景和取舍。' },
];

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

export default function ChatScreen() {
  const { conversations, activeId, sidebarOpen, dispatch } = useChat();
  const { drafts, setDraft } = useDrafts();
  const runtime = useChatRuntime();
  const settingsHref: Href = `${useSettingsRoot()}/models`;
  const conversation = conversations.find((item) => item.id === activeId);
  const lastMessage = conversation?.messages.at(-1);
  const failedReply = lastMessage?.role === 'assistant' && lastMessage.status === 'error' ? lastMessage : null;
  const messages = conversation?.messages ?? [];
  const draftKey = activeId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const messageScroller = useRef<HTMLElement>(null);
  const followReply = useRef(true);
  const hasMessages = !!conversation?.messages.length;
  const latestContent = conversation?.messages.at(-1)?.content;
  const latestReasoning = conversation?.messages.at(-1)?.reasoning;

  useEffect(() => {
    followReply.current = true;
    const scroller = messageScroller.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [activeId]);
  useEffect(() => {
    const scroller = messageScroller.current;
    if (scroller && followReply.current) scroller.scrollTop = scroller.scrollHeight;
  }, [conversation?.messages.length, latestContent, latestReasoning]);
  function changeDraft(value: string) { setDraft(draftKey, value); }
  function send() {
    const content = draft.trim();
    if (!content) return;
    if (runtime.send(content, activeId)) setDraft(draftKey, '');
  }

  return <main ref={messageScroller} onScroll={(event) => { const element = event.currentTarget; followReply.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }} className={`chat-main ${hasMessages ? 'has-messages' : 'is-empty'}`} id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      {!sidebarOpen && <button className="sidebar-expand" type="button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏" aria-expanded={false}><Icon name="sidebar" size={22} /></button>}
      {conversation && <ConversationTitle key={conversation.id} title={conversation.title}
        onRename={(title) => dispatch({ type: 'rename', id: conversation.id, title })} />}
    </header>
    {runtime.error && <div className="chat-runtime-notice" role="alert"><span>{runtime.error}</span><Link href={settingsHref} asChild><LinkAnchor>配置模型</LinkAnchor></Link><button className="icon-button" aria-label="关闭提示" onClick={runtime.clearError}><Icon name="close" size={16} /></button></div>}
    {runtime.runningId && runtime.runningId !== activeId && <div className="chat-runtime-notice" role="status"><span>另一个对话正在生成回复。</span><button onClick={runtime.stop}>停止生成</button></div>}
    {hasMessages ? <>
      <div className="messages-scroll">
        <div className="messages-content">
          {messages.map((message) => {
            if (message.role === 'assistant' && message.status === 'error' && !message.content.trim() && !message.reasoning?.trim()) {
              if (message.id === failedReply?.id) return null;
              return <div className="reply-error-notice reply-error-history" key={message.id} role="status"><span>{message.error ?? '模型回复失败。'}</span></div>;
            }
            return message.role === 'user'
              ? <article className="user-message" key={message.id} aria-label="你的消息"><div className="user-message-content"><MessageContent content={message.content} /></div><MessageActions message={message} /></article>
              : <article className="assistant-message" key={message.id} aria-label="助手回复">
              {message.reasoning && <details className="message-reasoning"><summary>思考过程</summary><MessageContent content={message.reasoning} /></details>}
              <MessageContent content={message.content} />
              {message.status === 'streaming' && !message.content && <p className="reply-status" role="status">正在等待模型回复…</p>}
              {message.status === 'complete' && message.error && <p className="reply-status" role="status">{message.error}</p>}
              {message.status === 'error' && message.error && message.id !== failedReply?.id && <div className="reply-error-notice reply-error-history" role="status"><span>{message.error}</span></div>}
              {message.status === 'stopped' && <p className="reply-status">已停止生成</p>}
              {message.status !== 'streaming' && message.content.trim() && <MessageActions message={message} onFork={() => dispatch({ type: 'fork', conversationId: conversation.id, messageId: message.id, forkId: createId(), updatedAt: Date.now() })} />}
              {message.status === 'stopped' && message.id === lastMessage?.id && <button className="secondary-button" disabled={runtime.runningId !== null} onClick={() => runtime.retry(conversation.id)}>重新生成</button>}
            </article>;
          })}
          {failedReply && runtime.runningId === conversation.id && <p className="reply-status" role="status">正在重新连接模型…</p>}
          {failedReply && runtime.runningId !== conversation.id && <div className="reply-error-notice" role="alert" aria-live="assertive">
            <div className="reply-error-copy"><strong>回复失败</strong><span>{failedReply.error ?? '模型回复失败，请稍后重试。'}</span></div>
            <button className="secondary-button reply-error-retry" type="button" disabled={runtime.runningId !== null} onClick={() => runtime.retry(conversation.id)}><Icon name="refresh" size={15} />重新生成</button>
          </div>}
          {runtime.runningId === conversation.id && lastMessage?.role === 'user' && <p className="reply-status" role="status">正在连接模型…</p>}
          {!runtime.runningId && lastMessage?.role === 'user' && <button className="secondary-button" onClick={() => runtime.retry(conversation.id)}>生成回复</button>}
        </div>
      </div>
      <div className="bottom-composer"><Composer value={draft} onChange={changeDraft} onSend={send} /></div>
    </> : <div className="welcome-scroll"><div className="welcome-content">
      <div className="welcome-heading"><span className="welcome-mark"><Icon name="sparkle" size={30} /></span><h2>有什么可以帮你的？</h2><p>让好奇有回响，让想法更进一步。</p></div>
      <Composer value={draft} onChange={changeDraft} onSend={send} />
      <div className="suggestions" aria-label="对话灵感">
        {suggestions.map((item) => <button key={item.title} onClick={() => { changeDraft(item.prompt); document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus(); }}><Icon name={item.icon} size={17} /><span>{item.title}</span></button>)}
      </div>
    </div></div>}
  </main>;
}
