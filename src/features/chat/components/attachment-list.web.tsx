import { useState } from 'react';
import { X } from 'lucide-react';

import { Dialog } from '@/components/web/dialog';
import { FileTypeIcon } from './file-type-icon.web';

export type StagedAttachment = { id: string; file: globalThis.File; preview: string | null };

function fileDetails(file: globalThis.File) {
  const size = file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024
    ? `${Math.round(file.size / 1024)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  return { size };
}

export function ImagePreview({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  return <Dialog title={name} className="image-preview-dialog" onClose={onClose}>
    <div className="image-preview-stage" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><img src={src} alt={name} /></div>
  </Dialog>;
}

export function AttachmentList({ attachments, removingDisabled, onRemove }: {
  attachments: StagedAttachment[];
  removingDisabled: boolean;
  onRemove: (attachment: StagedAttachment) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = attachments.find((attachment) => attachment.id === previewId);
  return <>
    <div className="composer-attachments" aria-label="待发送的附件" role="list">
      {attachments.map((attachment) => {
        const { size } = fileDetails(attachment.file);
        return <div className="composer-attachment" key={attachment.id} title={attachment.file.name} role="listitem">
          <div className={`attachment-artwork${attachment.preview ? ' is-image' : ''}`}>
            {attachment.preview ? <button className="attachment-preview-trigger" type="button" aria-label={`预览图片 ${attachment.file.name}`} onClick={() => setPreviewId(attachment.id)}><img src={attachment.preview} alt="" /></button>
              : <FileTypeIcon file={attachment.file} />}
          </div>
          <span className="attachment-copy"><span className="attachment-name" title={attachment.file.name}>{attachment.file.name}</span><span className="attachment-meta">{size}</span></span>
          <button type="button" className="composer-attachment-remove" disabled={removingDisabled} aria-label={`移除附件 ${attachment.file.name}`} onClick={() => onRemove(attachment)}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>;
      })}
    </div>
    {preview?.preview && <ImagePreview src={preview.preview} name={preview.file.name} onClose={() => setPreviewId(null)} />}
  </>;
}
