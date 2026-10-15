import { memo, useEffect, useRef, useState } from 'react';

import { Icon } from '@/components/web/icon';
import { copyText } from '@/core/platform/clipboard.web';
import type { Message } from '../chat-state';

type Props = { message: Message; onFork?: () => void };

export const MessageActions = memo(function MessageActions({ message, onFork }: Props) {
  const [feedback, setFeedback] = useState<'good' | 'bad' | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const resetCopy = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (resetCopy.current) clearTimeout(resetCopy.current);
    };
  }, []);

  async function copy() {
    if (resetCopy.current) clearTimeout(resetCopy.current);
    let status: string;
    try { await copyText(message.content); status = '已复制'; }
    catch { status = '复制失败，请手动选择消息'; }
    if (!mounted.current) return;
    setCopyStatus(status);
    resetCopy.current = setTimeout(() => setCopyStatus(''), 2500);
  }

  return <div className="message-actions" role="group" aria-label={message.role === 'user' ? '用户消息操作' : 'AI 回复操作'}>
    <span className="sr-only" role="status">{copyStatus}</span>
    <button className={`message-action${copyStatus.startsWith('复制失败') ? ' copy-failed' : ''}`} type="button" onClick={copy} aria-label="复制消息">
      <Icon name={copyStatus === '已复制' ? 'check' : 'copy'} size={17} />
    </button>
    {message.role === 'assistant' && <>
      <button className="message-action" type="button" aria-label="赞" aria-pressed={feedback === 'good'} onClick={() => setFeedback((value) => value === 'good' ? null : 'good')}><Icon name="good" size={17} /></button>
      <button className="message-action" type="button" aria-label="踩" aria-pressed={feedback === 'bad'} onClick={() => setFeedback((value) => value === 'bad' ? null : 'bad')}><Icon name="bad" size={17} /></button>
      <button className="message-action" type="button" aria-label="从此处创建分支对话" onClick={onFork}><Icon name="fork" size={17} /></button>
    </>}
  </div>;
});
