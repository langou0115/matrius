import { useEffect } from 'react';
import { router } from '@/router';

import { Icon } from '@/components/web/icon';
import { useIsPreview } from '@/features/workspace/preview-context';
import { useChat } from '../chat-state';
import { useChatRuntime, type BackgroundNotification } from '../chat-runtime';
import { conversationHref } from '../conversation-href';

const DISMISS_AFTER_MS = 5000;

function NotificationCard({ notification, onDismiss }: { notification: BackgroundNotification; onDismiss: (id: string) => void }) {
  const preview = useIsPreview();
  // Keyed by createdAt as well, so a newer completion restarts the countdown rather than
  // inheriting the remainder of an older one.
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(notification.id), DISMISS_AFTER_MS);
    return () => clearTimeout(timer);
  }, [notification.id, notification.createdAt, onDismiss]);

  return <button type="button" className="background-notification"
    aria-label={`打开对话：${notification.title}。${notification.preview}`}
    onClick={() => {
      onDismiss(notification.id);
      router.push(conversationHref(notification.conversationId, preview));
    }}>
    <span className="background-notification-icon" aria-hidden="true"><Icon name="check" size={15} /></span>
    <span className="background-notification-copy"><strong>{notification.title}</strong><span>{notification.preview}</span></span>
  </button>;
}

/** Completion cards for replies that finished while the reader was in another conversation. */
export function BackgroundNotifications() {
  const { conversations } = useChat();
  const { notifications, dismissNotification } = useChatRuntime();
  // A conversation can be deleted while its card is still on screen.
  const visible = notifications.filter((notification) => conversations.some((conversation) => conversation.id === notification.conversationId));
  // The live region stays mounted so assistive technology announces cards as they appear.
  return <div className="background-notifications" aria-live="polite">
    {visible.map((notification) => <NotificationCard key={notification.id} notification={notification} onDismiss={dismissNotification} />)}
  </div>;
}
