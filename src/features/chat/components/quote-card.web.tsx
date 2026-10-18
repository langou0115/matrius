import { useState } from 'react';
import { Quote, X } from 'lucide-react';

import { Dialog } from '@/components/web/dialog';

export function QuoteCard({ content, onRemove }: { content: string; onRemove?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <div className="quote-card" role="note" aria-label="引用内容">
      <Quote size={16} strokeWidth={1.75} aria-hidden="true" />
      <button type="button" className="quote-card-preview" aria-label="查看完整引用" onClick={() => setExpanded(true)}>
        <span>{content}</span>
      </button>
      {onRemove && <button type="button" className="quote-card-remove" aria-label="移除引用" onClick={onRemove}><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>}
    </div>
    {expanded && <Dialog title="引用内容" className="quote-dialog" onClose={() => setExpanded(false)}>
      <div className="quote-full-content">{content}</div>
    </Dialog>}
  </>;
}
