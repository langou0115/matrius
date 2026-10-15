import { useEffect, useRef } from 'react';

import { Icon, type IconName } from '@/components/web/icon';
import { useChat } from './chat-state';
import { Composer } from './components/composer.web';
import { useDrafts } from './draft-state';
import { MessageContent } from './components/message-content.web';

const suggestions: { icon: IconName; title: string; prompt: string }[] = [
  { icon: 'bolt', title: '解释一个概念', prompt: '用通俗的方式解释一个概念，并举一个具体的例子。' },
  { icon: 'code', title: '帮我看看代码', prompt: '帮我看看接下来这段代码，有哪些可以改进的地方？' },
  { icon: 'pen', title: '润色文字', prompt: '帮我把接下来的文字改得更简洁，保留原意。' },
  { icon: 'compare', title: '做个技术选型', prompt: '帮我比较两个技术方案的适用场景和取舍。' },
];

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ChatScreen() {
  const { conversations, activeId, sidebarOpen, dispatch } = useChat();
  const { drafts, setDraft } = useDrafts();
  const conversation = conversations.find((item) => item.id === activeId);
  const draftKey = activeId ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const messagesEnd = useRef<HTMLDivElement>(null);
  const hasMessages = !!conversation?.messages.length;

  useEffect(() => { messagesEnd.current?.scrollIntoView({ block: 'end' }); }, [activeId, conversation?.messages.length]);
  function changeDraft(value: string) { setDraft(draftKey, value); }
  function send() {
    const content = draft.trim();
    if (!content) return;
    const conversationId = activeId ?? createId();
    dispatch({ type: 'send', conversationId, message: { id: createId(), role: 'user', content } });
    setDraft(draftKey, '');
    setDraft(conversationId, '');
  }

  return <main className={`chat-main ${hasMessages ? 'has-messages' : 'is-empty'}`} id="main-content" tabIndex={-1}>
    <header className="chat-topbar">
      {!sidebarOpen && <button className="icon-button" onClick={() => dispatch({ type: 'sidebar' })} aria-label="展开侧栏"><Icon name="sidebar" /></button>}
      {conversation && <h1>{conversation.title}</h1>}
    </header>
    {hasMessages ? <>
      <div className="messages-scroll">
        <div className="messages-content">
          {conversation.messages.map((message) => message.role === 'user'
            ? <article className="user-message" key={message.id} aria-label="你的消息"><p>{message.content}</p></article>
            : <article className="assistant-message" key={message.id} aria-label="助手回复"><MessageContent content={message.content} /></article>)}
          {conversation.messages.at(-1)?.role === 'user' && <div className="connection-notice" role="status"><Icon name="info" size={18} /><div><strong>模型尚未连接</strong><p>暂时无法生成回复。连接模型后即可继续对话。</p></div></div>}
          <div ref={messagesEnd} />
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
