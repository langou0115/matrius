import { Check, Download, Pencil, Trash2 } from 'lucide-react';

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
  const created = formatDate(file.createdAt);
  const contentUrl = file.previewUrl ?? fileContentUrl(file.id);
  return <div className={`library-item${selected ? ' is-selected' : ''}`} role="listitem">
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
    <div className="library-item-actions">
      <a className="icon-button" href={contentUrl} download={file.filename}
        aria-label={`下载 ${file.filename}`} title="下载">
        <Download size={17} strokeWidth={1.75} aria-hidden="true" />
      </a>
      <button className="icon-button" type="button" aria-label={`重命名 ${file.filename}`}
        title="重命名" onClick={onRename}>
        <Pencil size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button className="icon-button danger-icon" type="button" aria-label={`删除 ${file.filename}`}
        title="删除" onClick={onDelete}>
        <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  </div>;
}
