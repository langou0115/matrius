import { memo, useEffect, useRef } from 'react';
import { Icon } from '@/components/web/icon';
import { SidebarScrollingLabel } from '@/components/web/sidebar-scrolling-label';

type Props = {
  title: string;
  active: boolean;
  hasUnreadError?: boolean;
  /** Background state shown instead of the error mark: still generating, or finished unread. */
  status?: 'running' | 'completed';
  onSelect: () => void;
  onLongPress?: (anchor: HTMLButtonElement) => void;
};

export const ConversationSelect = memo(function ConversationSelect({ title, active, hasUnreadError = false, status, onSelect, onLongPress }: Props) {
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; x: number; y: number; opened: boolean }>({ x: 0, y: 0, opened: false });
  function cancelPress() {
    clearTimeout(press.current.timer);
    press.current.timer = undefined;
  }
  useEffect(() => cancelPress, []);


  return <button className="conversation-select" type="button" aria-current={active ? 'page' : undefined}
    onPointerDown={(event) => {
      cancelPress();
      press.current.opened = false;
      if (!onLongPress || event.pointerType === 'mouse' || !event.isPrimary) return;
      const anchor = event.currentTarget;
      press.current.x = event.clientX;
      press.current.y = event.clientY;
      press.current.timer = setTimeout(() => {
        press.current.opened = true;
        onLongPress(anchor);
      }, 500);
    }}
    onPointerMove={(event) => {
      if (Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress();
    }}
    onPointerUp={cancelPress} onPointerCancel={cancelPress}
    onContextMenu={(event) => {
      if (!onLongPress) return;
      event.preventDefault();
      cancelPress();
      if (!press.current.opened) {
        press.current.opened = true;
        onLongPress(event.currentTarget);
      }
    }}
    onClick={(event) => {
      if (press.current.opened) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onSelect();
    }}>
    <SidebarScrollingLabel className="conversation-title" title={title} />
    {hasUnreadError
      ? <span className="conversation-error-indicator" role="img" aria-label="此对话有未查看的回复错误"><Icon name="alert" size={16} /></span>
      : status === 'running'
        ? <span className="conversation-status-indicator conversation-spinner" role="status" aria-label="正在生成回复" />
        : status === 'completed'
          ? <span className="conversation-status-indicator conversation-completed-indicator" role="img" aria-label="回复已完成，尚未查看" />
          : null}
  </button>;
});
