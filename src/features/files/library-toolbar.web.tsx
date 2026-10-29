import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';

import { SelectField } from '@/components/web/select-field.web';
import { KIND_OPTIONS, SORT_OPTIONS, type LibraryKind, type LibraryOrder, type LibrarySort } from './types';

export function LibraryToolbar({ query, onQueryChange, kind, onKindChange, sort, onSortChange, order, onToggleOrder }: {
  query: string;
  onQueryChange: (value: string) => void;
  kind: LibraryKind;
  onKindChange: (value: LibraryKind) => void;
  sort: LibrarySort;
  onSortChange: (value: LibrarySort) => void;
  order: LibraryOrder;
  onToggleOrder: () => void;
}) {
  return <div className="library-toolbar">
    <div className="library-toolbar-row">
      <div className="library-search" role="search" aria-label="搜索资料库">
        <Search size={16} strokeWidth={1.75} aria-hidden="true" />
        <input type="search" aria-label="搜索文件名" placeholder="搜索文件" value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onQueryChange(''); }} />
        {query && <button type="button" className="icon-button" aria-label="清空搜索" onClick={() => onQueryChange('')}>
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>}
      </div>
      <div className="library-kinds" role="group" aria-label="文件类型">
        {KIND_OPTIONS.map((option) => <button key={option.id} type="button"
          className={`library-kind${kind === option.id ? ' is-active' : ''}`}
          aria-pressed={kind === option.id} onClick={() => onKindChange(option.id)}>
          {option.label}
        </button>)}
      </div>
      <div className="library-sort">
        <SelectField label="排序" value={sort} options={SORT_OPTIONS}
          onChange={(value) => onSortChange(value as LibrarySort)} />
        <button type="button" className="icon-button" onClick={onToggleOrder}
          aria-label={order === 'desc' ? '当前降序，切换为升序' : '当前升序，切换为降序'}
          title={order === 'desc' ? '降序' : '升序'}>
          {order === 'desc'
            ? <ArrowDown size={17} strokeWidth={1.75} aria-hidden="true" />
            : <ArrowUp size={17} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
    </div>
  </div>;
}
