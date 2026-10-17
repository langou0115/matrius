import { router } from 'expo-router';
import { useMemo, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { useChat } from '../chat-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { conversationHref } from '../conversation-href';

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { conversations } = useChat();
  const preview = useIsPreview();
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).flatMap((conversation) => {
      const message = conversation.messages.find((item) => item.content.toLocaleLowerCase().includes(needle));
      if (needle && !conversation.title.toLocaleLowerCase().includes(needle) && !message) return [];
      const content = message?.content;
      const start = content ? Math.max(0, content.toLocaleLowerCase().indexOf(needle) - 24) : 0;
      return [{ ...conversation, snippet: content ? `${start > 0 ? '…' : ''}${content.slice(start, start + 100)}` : null }];
    }).slice(0, 50);
  }, [conversations, query]);

  return <Dialog title="搜索对话" onClose={onClose} className="search-dialog">
    <div className="search-field"><Icon name="search" /><input aria-label="搜索标题和消息内容" placeholder="搜索标题或消息内容…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && results[0]) { event.preventDefault(); router.push(conversationHref(results[0].id, preview)); onClose(); } }} /><kbd>Esc</kbd></div>
    <div className="search-results" aria-live="polite">
      {results.length > 0 ? results.map((item) => <button className="search-result" key={item.id} onClick={() => { router.push(conversationHref(item.id, preview)); onClose(); }}>
        <Icon name="chat" size={19} /><span><strong>{item.title}</strong>{item.snippet && <span>{item.snippet}</span>}</span><Icon name="back" size={16} className="result-arrow" />
      </button>) : <div className="search-empty"><Icon name="search" size={30} /><strong>{query.trim() ? '没有找到相关对话' : '还没有可搜索的对话'}</strong><p>{query.trim() ? '试试其他关键词，标题和消息内容都可以搜索。' : '开始对话后，可以在这里快速找回。'}</p></div>}
    </div>
    <div className="search-footer">搜索当前会话中的对话记录<span>Enter 选择 · Esc 关闭</span></div>
  </Dialog>;
}
