import { memo, useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/web/icon';

type Props = { title: string; active: boolean; hasUnreadError?: boolean; onSelect: () => void };

export const ConversationSelect = memo(function ConversationSelect({ title, active, hasUnreadError = false, onSelect }: Props) {
  const viewport = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const engaged = hovered || focused;

  useEffect(() => {
    const container = viewport.current;
    const text = label.current;
    if (!engaged || !container || !text) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | undefined;
    let disposed = false;

    function measure() {
      if (disposed || !container || !text) return;
      animation?.cancel();
      delete container.dataset.scrolling;
      delete container.dataset.manual;
      container.scrollLeft = 0;
      const distance = text.scrollWidth - container.clientWidth;
      if (distance <= 1) return;
      container.dataset.scrolling = 'true';
      if (reducedMotion.matches || !text.animate) {
        container.dataset.manual = 'true';
        return;
      }
      const travelTime = distance / 35 * 1000;
      const duration = travelTime + 600;
      animation = text.animate([
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: 150 / duration },
        { transform: `translateX(-${distance}px)`, offset: 1 - 450 / duration },
        { transform: `translateX(-${distance}px)`, offset: 1 },
      ], { duration, iterations: Infinity, direction: 'alternate', easing: 'linear' });
    }
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    reducedMotion.addEventListener('change', measure);
    void document.fonts?.ready.then(measure);
    window.addEventListener('resize', measure);
    return () => {
      disposed = true;
      animation?.cancel();
      observer?.disconnect();
      reducedMotion.removeEventListener('change', measure);
      window.removeEventListener('resize', measure);
      delete container.dataset.scrolling;
      delete container.dataset.manual;
      container.scrollLeft = 0;
    };
  }, [engaged, title]);

  return <button className="conversation-select" type="button" aria-current={active ? 'page' : undefined}
    onClick={onSelect} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible'))} onBlur={() => setFocused(false)}>
    <span className="conversation-title" ref={viewport}><span className="conversation-title-text" ref={label}>{title}</span></span>
    {hasUnreadError && <span className="conversation-error-indicator" role="img" aria-label="此对话有未查看的回复错误"><Icon name="alert" size={16} /></span>}
  </button>;
});
