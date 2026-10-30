import { Check, Download, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { FileTypeIcon } from '@/features/chat/components/file-type-icon.web';
import { fileContentUrl, type LibraryFile } from './files-api.web';
import { formatBytes, formatDate, isImageFilename } from './types';

export function LibraryItem({ file, selected, onToggle, onRename, onDelete }: {
  file: LibraryFile;
  selected: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const created = formatDate(file.createdAt);
  const contentUrl = file.previewUrl ?? fileContentUrl(file.id);

  // One settings menu replaces the per-row buttons; outside clicks and Escape dismiss it.
  useEffect(() => {
    if (!menuOpen) return;
    function dismissOnPointerDown(event: PointerEvent) {
      if (!actions.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('pointerdown', dismissOnPointerDown);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOnPointerDown);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [menuOpen]);

  return <div className={`library-item${selected ? ' is-selected' : ''}${menuOpen ? ' is-menu-open' : ''}`} role="listitem">
    <button type="button" className="library-item-main" aria-pressed={selected}
      aria-label={`${selected ? '取消选择' : '选择'} ${file.filename}`} onClick={onToggle}>
      <span className={`library-item-check${selected ? ' is-checked' : ''}`} aria-hidden="true">
        {selected && <Check size={13} strokeWidth={2.5} />}
      </span>
      <span className="library-item-artwork">
        {isImageFilename(file.filename)
          ? <img src={contentUrl} alt="" loading="lazy" decoding="async" />
          : <FileTypeIcon file={{ name: file.filename, type: file.contentType }} />}
      </span>
      <span className="library-item-copy">
        <span className="library-item-name" title={file.filename}>{file.filename}</span>
        <span className="library-item-meta">{formatBytes(file.size)}{created ? ` · ${created}` : ''}</span>
      </span>
    </button>
    <div className="library-item-actions" ref={actions}>
      <button type="button" className="icon-button" aria-label={`更多操作 ${file.filename}`}
        aria-haspopup="menu" aria-expanded={menuOpen} title="更多操作"
        onClick={() => setMenuOpen((open) => !open)}>
        <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {menuOpen && <div className="library-item-menu" role="menu" aria-label={`${file.filename} 的操作`}>
        <a role="menuitem" href={contentUrl} download={file.filename} onClick={() => setMenuOpen(false)}>
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />下载
        </a>
        <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); onRename(); }}>
          <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />重命名
        </button>
        <button role="menuitem" type="button" className="is-danger" onClick={() => { setMenuOpen(false); onDelete(); }}>
          <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />删除
        </button>
      </div>}
    </div>
  </div>;
}
