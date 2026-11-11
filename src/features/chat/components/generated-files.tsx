import { useId, useState } from 'react';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';

import type { MessageFile } from '@/core/agent/types';
import { fileContentUrl } from '@/features/files/files-api';
import { useIsPreview } from '@/features/workspace/preview-context';
import { formatFileSize } from './attachment-list';
import { FileTypeIcon } from './file-type-icon';

/** Long replies stay readable: only short lists start open. */
const COLLAPSE_THRESHOLD = 3;

function triggerDownload(href: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** History keeps no operation, so a newer revision still tells us the file was modified. */
function fileAction(file: MessageFile): string {
  if (file.operation === 'edit') return '修改';
  if (file.operation === 'create' || file.operation === 'save') return '创建';
  return (file.revision ?? 1) > 1 ? '修改' : '创建';
}

/**
 * Files saved to the Library during a reply. They render only once the answer has finished,
 * as one collapsed card after the text, mirroring the reference file-results block.
 */
export function GeneratedFiles({ files }: { files: MessageFile[] }) {
  const listId = useId();
  const preview = useIsPreview();
  const [expanded, setExpanded] = useState(files.length <= COLLAPSE_THRESHOLD);
  if (!files.length) return null;

  // The preview has no server to serve file bytes, so hand out a placeholder file instead.
  function downloadFile(file: MessageFile) {
    if (!preview) { triggerDownload(fileContentUrl(file.id), file.filename); return; }
    const url = URL.createObjectURL(new Blob([`${file.filename}\n`], { type: 'text/plain;charset=utf-8' }));
    triggerDownload(url, file.filename);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return <section className="generated-files" aria-label="生成的文件">
    <div className="generated-files-header">
      <button className="generated-files-toggle" type="button" aria-expanded={expanded} aria-controls={listId}
        onClick={() => setExpanded((open) => !open)}>
        <span className="generated-files-title">生成的文件</span>
        <span className="generated-files-count">{files.length} 个文件</span>
        {expanded ? <ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" /> : <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />}
      </button>
      <button className="generated-files-download" type="button" aria-label="下载全部文件" title="下载全部文件"
        onClick={() => files.forEach(downloadFile)}>
        <Download size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
    {expanded && <ul className="generated-files-list" id={listId}>
      {files.map((file) => <li key={file.id}>
        <button className="generated-file" type="button"
          aria-label={`下载 ${file.filename}`} title={file.filename} onClick={() => downloadFile(file)}>
          <span className="generated-file-icon">
            <FileTypeIcon file={{ name: file.filename, type: file.contentType }} />
          </span>
          <span className="generated-file-copy">
            <span className="generated-file-name">{file.filename}</span>
            <span className="generated-file-meta">
              <span className="generated-file-action">{fileAction(file)}</span>
              <span>{formatFileSize(file.size)}</span>
            </span>
          </span>
        </button>
      </li>)}
    </ul>}
  </section>;
}
