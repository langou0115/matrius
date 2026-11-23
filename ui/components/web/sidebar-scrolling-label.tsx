import { useEffect, useRef, useState } from 'react';

export function SidebarScrollingLabel({ title, className }: { title: string; className?: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [engaged, setEngaged] = useState(false);

  useEffect(() => {
    const trigger = viewport.current?.parentElement;
    if (!trigger) return;
    let hovered = false;
    let focused = false;
    const onEnter = () => { hovered = true; setEngaged(true); };
    const onLeave = () => { hovered = false; setEngaged(focused); };
    const onFocus = () => {
      focused = trigger.matches(':focus-visible');
      setEngaged(hovered || focused);
    };
    const onBlur = () => { focused = false; setEngaged(hovered); };
    trigger.addEventListener('mouseenter', onEnter);
    trigger.addEventListener('mouseleave', onLeave);
    trigger.addEventListener('focus', onFocus);
    trigger.addEventListener('blur', onBlur);
    return () => {
      trigger.removeEventListener('mouseenter', onEnter);
      trigger.removeEventListener('mouseleave', onLeave);
      trigger.removeEventListener('focus', onFocus);
      trigger.removeEventListener('blur', onBlur);
    };
  }, []);

  useEffect(() => {
    const container = viewport.current;
    const text = label.current;
    if (!engaged || !container || !text) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | undefined;
    let disposed = false;

    function reset() {
      if (!container) return;
      animation?.cancel();
      delete container.dataset.scrolling;
      delete container.dataset.manual;
      container.scrollLeft = 0;
    }

    function measure() {
      if (disposed || !container || !text) return;
      reset();
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
      reset();
      observer?.disconnect();
      reducedMotion.removeEventListener('change', measure);
      window.removeEventListener('resize', measure);
    };
  }, [engaged, title]);

  return (
    <span className={['sidebar-scrolling-label', className].filter(Boolean).join(' ')} ref={viewport}>
      <span className="sidebar-scrolling-label-text" ref={label}>{title}</span>
    </span>
  );
}
