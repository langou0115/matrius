import { useEffect, useLayoutEffect, useRef, type PropsWithChildren } from 'react';

type SidebarMenuProps = PropsWithChildren<{
  id: string;
  label: string;
  anchor: HTMLElement;
  focusReturnTarget?: HTMLElement | null;
  rowSelector: string;
  align?: 'start' | 'end';
  dismissOnAnchorPointerDown?: boolean;
  onClose: () => void;
}>;

/** Floating row action card shared by sidebar conversation and project menus. */
export function SidebarMenu({
  id,
  label,
  anchor,
  focusReturnTarget,
  rowSelector,
  align = 'start',
  dismissOnAnchorPointerDown = false,
  onClose,
  children,
}: SidebarMenuProps) {
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const drawer = anchor.closest('dialog')?.getBoundingClientRect();
    const row = (drawer || align === 'end')
      ? anchor.closest(rowSelector)?.getBoundingClientRect()
      : undefined;
    // Right-aligned row menus (`align === 'end'`) anchor to the full row edge;
    // action-slot menus use the 32px trailing slot inside drawers or the trigger button rect.
    const trigger = align === 'end' && row
      ? row
      : drawer && row
        ? {
            left: row.right - 37,
            right: row.right,
            top: row.top + row.height / 2 - 16,
            bottom: row.top + row.height / 2 + 16,
          }
        : anchor.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const viewportW = window.innerWidth || document.documentElement?.clientWidth || 1024;
    const viewportH = window.innerHeight || document.documentElement?.clientHeight || 768;
    const leftEdge = (drawer?.left ?? 0) + 8;
    const rightEdge = (drawer?.right ?? viewportW) - 8;
    const topEdge = (drawer?.top ?? 0) + 8;
    const bottomEdge = (drawer?.bottom ?? viewportH) - 8;
    const desiredLeft = align === 'end' ? trigger.right - width : trigger.left;
    const left = Math.max(leftEdge, Math.min(desiredLeft, rightEdge - width));
    const top = trigger.bottom + height + 6 <= bottomEdge
      ? trigger.bottom + 6
      : Math.max(topEdge, trigger.top - height - 6);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [align, anchor, rowSelector]);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (menu.current?.contains(event.target)) return;
      if (!dismissOnAnchorPointerDown && anchor.contains(event.target)) return;
      onClose();
    }
    function handleScroll(event: Event) {
      // Only close when a container holding the anchor element scrolls (e.g. the sidebar list);
      // chat stream auto-scroll in `.messages-scroll` must not dismiss the sidebar menu.
      const target = event.target;
      if (target === document || target === window || (target instanceof Node && target.contains(anchor))) {
        onClose();
      }
    }
    function dismiss() { onClose(); }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [anchor, dismissOnAnchorPointerDown, onClose]);

  return (
    <div
      ref={menu}
      id={id}
      className="conversation-menu"
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') event.preventDefault();
          (focusReturnTarget ?? anchor).focus();
          onClose();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}
