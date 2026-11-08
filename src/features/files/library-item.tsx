import { Check, Download, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { FileTypeIcon } from '@/features/chat/components/file-type-icon';
import { fileContentUrl, type LibraryFile } from './files-api';
import { formatBytes, formatDate, isImageFilename } from './types';
import { LibraryMenu } from './library-menu';

export function LibraryItem({ file, selected, selectable = true, onToggle, onRename, onDelete, mobile = false }: {
  file: LibraryFile;
  selected: boolean;
  selectable?: boolean;
  mobile?: boolean;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const main = useRef<HTMLButtonElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const created = formatDate(file.createdAt);
  const contentUrl = file.previewUrl ?? fileContentUrl(file.id);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number; fired: boolean }>({ x: 0, y: 0, fired: false });
  function cancelPress() {
    clearTimeout(press.current.timer);
    press.current.timer = undefined;
  }
  useEffect(() => cancelPress, []);

  return <div className={`library-item${selected ? ' is-selected' : ''}${menuOpen ? ' is-menu-open' : ''}`} role="listitem">
    {mobile && selectable && <button type="button" className="library-item-select-control"
      aria-label={`${selected ? '取消选择' : '选择'} ${file.filename}`} aria-pressed={selected} onClick={onToggle}>
      <span className={`library-item-check${selected ? ' is-checked' : ''}`} aria-hidden="true">
        {selected && <Check size={13} strokeWidth={2.5} />}
      </span>
    </button>}
    <button ref={main} type="button" className={`library-item-main${mobile ? ' supports-long-press' : ''}`}
      onPointerDown={(event) => {
        cancelPress();
        press.current.fired = false;
        if (!mobile || !event.isPrimary || event.button !== 0) return;
        press.current.x = event.clientX;
        press.current.y = event.clientY;
        press.current.timer = setTimeout(() => {
          press.current.fired = true;
          setMenuOpen(true);
        }, 500);
      }}
      onPointerMove={(event) => {
        if (Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}
      onContextMenu={(event) => {
        if (!mobile) return;
        event.preventDefault();
        cancelPress();
        press.current.fired = true;
        setMenuOpen(true);
      }}
      aria-pressed={selectable ? selected : undefined}
      aria-label={selectable ? `${selected ? '取消选择' : '选择'} ${file.filename}` : `文件操作 ${file.filename}`}
      aria-haspopup={mobile ? 'menu' : undefined}
      aria-expanded={mobile ? menuOpen : undefined}
      onClick={(event: MouseEvent) => {
        if (press.current.fired) {
          press.current.fired = false;
          event.preventDefault();
          return;
        }
        if (selectable) onToggle();
        else if (mobile && event.detail === 0) setMenuOpen(true);
      }}>
      {selectable && !mobile && <span className={`library-item-check${selected ? ' is-checked' : ''}`} aria-hidden="true">
        {selected && <Check size={13} strokeWidth={2.5} />}
      </span>}
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
    {!mobile && <div className="library-item-actions">
      <button ref={more} type="button" className="icon-button" aria-label={`更多操作 ${file.filename}`}
        aria-haspopup="menu" aria-expanded={menuOpen} title="更多操作"
        onClick={() => setMenuOpen((open) => !open)}>
        <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>}
      {menuOpen && (mobile ? main.current : more.current) && <LibraryMenu anchor={(mobile ? main.current : more.current)!} label={`${file.filename} 的操作`} onClose={() => setMenuOpen(false)}>
        <a role="menuitem" href={contentUrl} download={file.filename} onClick={() => setMenuOpen(false)}>
          <Download size={16} strokeWidth={1.75} aria-hidden="true" />下载
        </a>
        <button role="menuitem" type="button" onClick={() => { setMenuOpen(false); onRename(); }}>
          <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />重命名
        </button>
        <button role="menuitem" type="button" className="is-danger" onClick={() => { setMenuOpen(false); onDelete(); }}>
          <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />删除
        </button>
      </LibraryMenu>}
  </div>;
}
