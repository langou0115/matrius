import { useState } from 'react';
import { X } from 'lucide-react';

import { Dialog } from '@/components/web/dialog';
import type { LibraryFile } from '@/features/files/files-api.web';
import { FileTypeIcon } from './file-type-icon.web';

export type StagedAttachment = {
  id: string;
  file: globalThis.File;
  preview: string | null;
  /** Cloud upload state; absent when the account cannot use the Library. */
  status?: 'uploading' | 'ready' | 'error';
  fileId?: string;
  serverFile?: LibraryFile;
  controller?: AbortController;
  /** Set once the attachment has been handed to an outgoing message; cleanup must keep it. */
  consumed?: boolean;
};

export function formatFileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileDetails(file: globalThis.File) {
  return { size: formatFileSize(file.size) };
}

export function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  return <Dialog title={name} className="image-preview-dialog" onClose={onClose}>
    <div className="image-preview-stage" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><img src={src} alt={name} /></div>
  </Dialog>;
}

export function AttachmentList({ attachments, removingDisabled, onRemove, onRetry }: {
  attachments: StagedAttachment[];
  removingDisabled: boolean;
  onRemove: (attachment: StagedAttachment) => void;
  onRetry?: (attachment: StagedAttachment) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = attachments.find((attachment) => attachment.id === previewId);
  return <>
    <div className="composer-attachments" aria-label="待发送的附件" role="list">
      {attachments.map((attachment) => {
        const { size } = fileDetails(attachment.file);
        const meta = attachment.status === 'uploading' ? '上传中…' : size;
        return <div className={`composer-attachment${attachment.status === 'error' ? ' has-error' : ''}`}
          key={attachment.id} title={attachment.file.name} role="listitem">
          <div className={`attachment-artwork${attachment.preview ? ' is-image' : ''}`}>
            {attachment.preview ? <button className="attachment-preview-trigger" type="button" aria-label={`预览图片 ${attachment.file.name}`} onClick={() => setPreviewId(attachment.id)}><img src={attachment.preview} alt="" /></button>
              : <FileTypeIcon file={attachment.file} />}
          </div>
          <span className="attachment-copy"><span className="attachment-name" title={attachment.file.name}>{attachment.file.name}</span><span className="attachment-meta">{meta}</span></span>
          {attachment.status === 'error' && onRetry
            ? <button type="button" className="composer-attachment-retry" disabled={removingDisabled} onClick={() => onRetry(attachment)}>重试</button>
            : null}
          <button type="button" className="composer-attachment-remove" disabled={removingDisabled} aria-label={`移除附件 ${attachment.file.name}`} onClick={() => onRemove(attachment)}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>;
      })}
    </div>
    {preview?.preview && <ImagePreview src={preview.preview} name={preview.file.name} onClose={() => setPreviewId(null)} />}
  </>;
}
