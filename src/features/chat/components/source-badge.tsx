import { Link2 } from 'lucide-react';
import { memo } from 'react';

/**
 * The "N 个网页" control under an answer. It opens the source column, where the cited numbers match
 * the superscript markers in the text. It sits above the feedback row and only appears once the
 * reply has stopped streaming and the sources are final.
 */
export const SourceBadge = memo(function SourceBadge({ count, open = false, onOpen }: {
  count: number;
  open?: boolean;
  onOpen: (opener: HTMLElement) => void;
}) {
  if (count <= 0) return null;
  return <button type="button" className="message-sources" aria-haspopup="dialog" aria-expanded={open}
    aria-label={`${count} 个网页，查看来源`} onClick={(event) => onOpen(event.currentTarget)}>
    <Link2 size={13} strokeWidth={2} aria-hidden="true" />
    <span>{count} 个网页</span>
  </button>;
});
