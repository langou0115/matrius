import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A small menu shared by the page actions and file actions. */
export function LibraryMenu({ anchor, label, onClose, children }: {
  anchor: HTMLElement;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const rect = anchor.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
    element.style.top = `${rect.bottom + height + 6 <= window.innerHeight - 8
      ? rect.bottom + 6 : Math.max(8, rect.top - height - 6)}px`;
    element.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [anchor]);
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose();
    }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [anchor, onClose]);
  return createPortal(<div className="library-item-menu library-floating-menu" ref={menu} role="menu" aria-label={label}
    onKeyDown={(event) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        anchor.focus({ preventScroll: true });
        onClose();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }
    }}>{children}</div>, anchor.closest('.matrius-app') ?? document.body);
}
