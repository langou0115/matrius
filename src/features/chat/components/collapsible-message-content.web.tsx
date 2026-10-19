import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { MessageContent } from './message-content.web';

/**
 * Long user messages fold to roughly eight lines so one pasted wall of text cannot bury the reply.
 * The decision is made from the rendered height, not a character count: the same text wraps to a
 * different number of lines on a phone and on a wide window, and only overflow is worth folding.
 */
export function CollapsibleMessageContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = body.current;
    // While expanded the body is at its natural height, so there is nothing left to measure.
    if (!element || expanded) return;
    const measure = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [content, expanded]);

  const folded = overflowing && !expanded;
  return <div className={`collapsible-message${expanded ? ' is-expanded' : ''}${folded ? ' is-folded' : ''}`}>
    <div ref={body} className="collapsible-message-body"><MessageContent content={content} /></div>
    {overflowing && <button className="collapsible-message-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
      <span>{expanded ? '收起' : '展开'}</span>
      {expanded ? <ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" /> : <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />}
    </button>}
  </div>;
}
