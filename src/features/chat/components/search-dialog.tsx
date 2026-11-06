import { router } from '@/router';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from 'react';

import { Dialog } from '@/components/web/dialog';
import { Icon } from '@/components/web/icon';
import { useChat } from '../chat-state';
import { useIsPreview } from '@/features/workspace/preview-context';
import { conversationHref } from '../conversation-href';
import { formatRelativeTime, searchConversations, splitMatches } from '../conversation-search';

const PAGE_SIZE = 20;
const LOAD_MORE_DISTANCE = 160;

function Highlighted({ text, query }: { text: string; query: string }) {
  return <>{splitMatches(text, query).map((part, index) =>
    part.match ? <mark key={index}>{part.text}</mark> : part.text)}</>;
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const { conversations } = useChat();
  const preview = useIsPreview();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [keyboardSelected, setKeyboardSelected] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const listRef = useRef<HTMLDivElement>(null);
  const results = useMemo(() => searchConversations(conversations, query), [conversations, query]);
  const visibleResults = results.slice(0, visibleCount);
  const hasMore = visibleCount < results.length;
  // Results shrink as the query narrows; keep the highlight inside the rendered page.
  const active = activeIndex < 0 ? -1 : Math.min(activeIndex, visibleResults.length - 1);
  const activeResult = visibleResults[active];

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [active, query]);

  function open(id: string) {
    router.push(conversationHref(id, preview));
    onClose();
  }

  function updateQuery(value: string) {
    setQuery(value);
    setActiveIndex(-1);
    setKeyboardSelected(false);
    setVisibleCount(PAGE_SIZE);
    if (listRef.current) listRef.current.scrollTop = 0;
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    if (!hasMore) return;
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight <= LOAD_MORE_DISTANCE) {
      setVisibleCount((count) => Math.min(count + PAGE_SIZE, results.length));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (results.length === 0) return;
      event.preventDefault();
      const next = active < 0
        ? 0
        : event.key === 'ArrowDown'
          ? Math.min(active + 1, results.length - 1)
          : Math.max(active - 1, 0);
      setActiveIndex(next);
      setKeyboardSelected(true);
      // Keyboard navigation can run past the rendered window; extend it in one page.
      if (next >= visibleCount) setVisibleCount(Math.min(visibleCount + PAGE_SIZE, results.length));
      return;
    }
    if (event.key === 'Enter' && results.length > 0) {
      event.preventDefault();
      open(activeResult?.id ?? results[0].id);
    }
  }

  return <Dialog title="搜索对话" onClose={onClose} className="search-dialog" hideHeader>
    <div className="search-input-row">
      <Icon name="search" size={20} />
      <input
        aria-activedescendant={activeResult ? `conversation-search-result-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls="conversation-search-results"
        aria-expanded={results.length > 0}
        aria-label="搜索对话"
        placeholder="搜索对话…"
        role="combobox"
        value={query}
        onChange={(event) => updateQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button type="button" className="icon-button search-close" aria-label="关闭搜索" onClick={onClose}><Icon name="close" size={18} /></button>
    </div>
    <div
      ref={listRef}
      id="conversation-search-results"
      className={`search-results${keyboardSelected ? ' is-keyboard-nav' : ''}`}
      role={results.length > 0 ? 'listbox' : undefined}
      aria-label={results.length > 0 ? '搜索结果' : undefined}
      onMouseLeave={() => { if (!keyboardSelected) setActiveIndex(-1); }}
      onScroll={handleScroll}
    >
      {results.length > 0 ? visibleResults.map((item, index) => <button
        type="button"
        role="option"
        id={`conversation-search-result-${index}`}
        aria-selected={index === active}
        aria-setsize={results.length}
        aria-posinset={index + 1}
        tabIndex={-1}
        className={`search-result ${keyboardSelected && index === active ? 'is-keyboard-selected' : ''}`}
        key={item.id}
        onMouseEnter={() => { setActiveIndex(index); setKeyboardSelected(false); }}
        onClick={() => open(item.id)}
      >
        <span className="search-result-copy">
          <span className="search-result-heading">
            <span className="search-result-title"><Highlighted text={item.title} query={query} /></span>
            <span className="search-result-time">{formatRelativeTime(item.updatedAt)}</span>
          </span>
          {item.snippet && <span className="search-result-sub"><Highlighted text={item.snippet} query={query} /></span>}
        </span>
      </button>) : <div className="search-empty">
        <span className="search-empty-icon"><Icon name="search" size={19} /></span>
        <strong>{query.trim() ? '没有找到相关对话' : '还没有可搜索的对话'}</strong>
        {query.trim() && <p>换个关键词试试，标题和消息内容都可以搜索。</p>}
      </div>}
    </div>
    <span className="sr-only" role="status" aria-live="polite">{query.trim() ? `找到 ${results.length} 个对话` : ''}</span>
  </Dialog>;
}
