import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import type { MessageImage } from '@/core/agent/types';
import { formatFileSize, ImagePreview } from './attachment-list.web';

/** Past this many images the stack starts folded, so one long message cannot push the reply away. */
const COLLAPSE_THRESHOLD = 3;

/**
 * Sent images sit above the user's bubble rather than inside it, matching the composer's attachment
 * cards: the bubble stays for what was typed (and any quote), while the files keep their own names
 * and sizes and can be opened full size.
 */
export function MessageAttachments({ images }: { images: MessageImage[] }) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Folded for long stacks, open for the common case; the fold stays until the reader unfolds it.
  const [expanded, setExpanded] = useState(images.length <= COLLAPSE_THRESHOLD);
  const preview = images.find((image) => image.id === previewId);
  const foldable = images.length > COLLAPSE_THRESHOLD;
  const totalSize = images.every((image) => image.size != null)
    ? images.reduce((sum, image) => sum + (image.size ?? 0), 0)
    : null;

  const cards = <div className="message-attachment-grid" role="list">
    {images.map((image) => <div className="composer-attachment message-attachment" key={image.id} title={image.name} role="listitem">
      <div className="attachment-artwork is-image">
        <button className="attachment-preview-trigger" type="button" aria-label={`预览图片 ${image.name}`} onClick={() => setPreviewId(image.id)}>
          <img src={image.dataUrl} alt="" />
        </button>
      </div>
      <span className="attachment-copy">
        <span className="attachment-name" title={image.name}>{image.name}</span>
        {image.size != null && <span className="attachment-meta">{formatFileSize(image.size)}</span>}
      </span>
    </div>)}
  </div>;

  return <>
    <div className="message-attachments" aria-label="已发送的图片">
      {foldable && <button className="message-attachments-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
        <span>{images.length} 张图片{totalSize != null ? ` · ${formatFileSize(totalSize)}` : ''}</span>
        {expanded ? <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />}
      </button>}
      {(!foldable || expanded) && cards}
    </div>
    {preview && <ImagePreview src={preview.dataUrl} name={preview.name} onClose={() => setPreviewId(null)} />}
  </>;
}
