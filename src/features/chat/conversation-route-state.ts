import { useEffect } from 'react';

import { useChat } from './chat-state';

export function useConversationRouteState(id: string | null) {
  const { conversations, activeId, dispatch } = useChat();
  const exists = id === null || conversations.some((conversation) => conversation.id === id);
  // Select only when the URL or its existence changes. Runtime updates must not reset selection.
  useEffect(() => {
    dispatch({ type: 'select', id: exists ? id : null });
  }, [id, exists, dispatch]);
  return { exists, ready: activeId === id };
}
