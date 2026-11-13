import { useEffect } from 'react';

import { useChat } from './chat-state';
import { conversationHref } from './conversation-href';

/** Where a launch on the bare root should go instead: the conversation the workspace last had
    open. Returns null when the URL already names a page, or the remembered conversation is gone
    (for example it was deleted on another device). */
export function resumeHref(pathname: string, activeId: string | null, conversations: { id: string }[]): string | null {
  if (pathname !== '/' || !activeId) return null;
  return conversations.some((conversation) => conversation.id === activeId) ? conversationHref(activeId, false) as string : null;
}

export function useConversationRouteState(id: string | null) {
  const { conversations, activeId, dispatch } = useChat();
  const exists = id === null || conversations.some((conversation) => conversation.id === id);
  // Select only when the URL or its existence changes. Runtime updates must not reset selection.
  useEffect(() => {
    dispatch({ type: 'select', id: exists ? id : null });
  }, [id, exists, dispatch]);
  return { exists, ready: activeId === id };
}
