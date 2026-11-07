import { useEffect, useLayoutEffect, useRef } from 'react';

import { Icon } from '@/components/web/icon';
import type { Conversation } from '../chat-state';

type Props = {
  conversation: Conversation;
  anchor: HTMLButtonElement;
  onClose: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
};

export function ConversationMenu({ conversation, anchor, onClose, onPin, onRename, onDelete }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const drawer = anchor.closest('dialog')?.getBoundingClientRect();
    const row = drawer ? anchor.closest('.conversation-item')?.getBoundingClientRect() : undefined;
    // Both gestures use the 32px action slot, 5px from the row's right edge.
    const trigger = row ? {
      left: row.right - 37,
      top: row.top + row.height / 2 - 16,
      bottom: row.top + row.height / 2 + 16,
    } : anchor.getBoundingClientRect();
    const { width, height } = element.getBoundingClientRect();
    const leftEdge = (drawer?.left ?? 0) + 8;
    const rightEdge = (drawer?.right ?? window.innerWidth) - 8;
    const topEdge = (drawer?.top ?? 0) + 8;
    const bottomEdge = (drawer?.bottom ?? window.innerHeight) - 8;
    const left = Math.max(leftEdge, Math.min(trigger.left, rightEdge - width));
    const top = trigger.bottom + height + 6 <= bottomEdge
      ? trigger.bottom + 6
      : Math.max(topEdge, trigger.top - height - 6);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [anchor]);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !anchor.contains(event.target)) onClose();
    }
    function dismiss() { onClose(); }
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [anchor, onClose]);

  return <div ref={menu} id="conversation-menu" className="conversation-menu" role="menu" aria-label={`对话操作：${conversation.title}`} onKeyDown={(event) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      anchor.focus();
      onClose();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[next]?.focus();
    }
  }}>
    <button role="menuitem" onClick={onPin}><Icon name="pin" size={17} />{conversation.pinned ? '取消置顶' : '置顶'}</button>
    <button role="menuitem" onClick={onRename}><Icon name="pen" size={17} />重命名</button>
    <button role="menuitem" className="danger-text" onClick={onDelete}><Icon name="trash" size={17} />删除</button>
  </div>;
}
