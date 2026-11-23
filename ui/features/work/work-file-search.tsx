import type { WorkFileSearchResponse, WorkFileTab } from '@contract/work-projects';
import { FileText, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { Dialog } from '@/components/web/dialog';
import { useInstance } from '@/features/instance/instance-state';
import { searchWorkFiles } from './work-api';

export function WorkFileSearch({ projectId, onClose, onOpen }: {
  projectId: string;
  onClose: () => void;
  onOpen: (file: WorkFileTab) => void;
}) {
  const { request } = useInstance();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<WorkFileSearchResponse>();
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const selected = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const term = query.trim();
    if (!term) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const response = await searchWorkFiles(request, projectId, term, controller.signal);
        if (controller.signal.aborted) return;
        setResult(response);
        setActive((previous) => Math.min(previous, Math.max(0, response.items.length - 1)));
        if (response.indexing) timer = setTimeout(() => void update(), 750);
      } catch (reason: unknown) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法搜索文件。');
      }
    }
    timer = setTimeout(() => void update(), 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, query, request]);

  useEffect(() => {
    selected.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const items = result?.items ?? [];
  const message = error || (!query.trim() ? '' : !result ? '正在搜索…'
    : result.indexing ? '正在建立本机索引，结果将继续更新…'
      : result.limited ? '结果或索引已达上限，可加上目录名缩小范围。'
        : items.length ? '' : '未找到匹配的文件。');
  return <Dialog title="查找本机文件" hideHeader className="work-file-search" onClose={onClose}>
    <div className="work-file-search-field">
      <Search size={18} aria-hidden="true" />
      <input
        className="text-field"
        role="combobox"
        aria-label="查找本机文件"
        aria-autocomplete="list"
        aria-expanded={items.length > 0}
        aria-controls={listId}
        aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
        placeholder="输入文件名或路径"
        value={query}
        maxLength={256}
        onInput={(event) => {
          setQuery(event.currentTarget.value);
          setResult(undefined);
          setError('');
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || !items.length) return;
          const direction = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
          if (direction) {
            event.preventDefault();
            setActive((previous) => (previous + direction + items.length) % items.length);
          } else if (event.key === 'Enter' && items[active]) {
            event.preventDefault();
            onOpen(items[active]);
          }
        }}
      />
    </div>
    <ul id={listId} className="work-file-search-results" role="listbox" aria-label="文件">
      {items.map((file, index) => (
        <li key={file.path} id={`${listId}-${index}`} role="option" ref={index === active ? selected : undefined}
          aria-selected={index === active} onMouseDown={(event) => event.preventDefault()} onClick={() => onOpen(file)}>
          <FileText size={16} aria-hidden="true" />
          <span title={file.path}><strong>{file.name}</strong><small>{file.path}</small></span>
        </li>
      ))}
    </ul>
    {message && <p className="work-file-search-status" role={error ? 'alert' : 'status'}>{message}</p>}
  </Dialog>;
}
