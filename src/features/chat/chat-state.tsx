import { createContext, useContext, useMemo, useReducer, type PropsWithChildren } from 'react';

export type Message = { id: string; role: 'user' | 'assistant'; content: string; reasoning?: string; status?: 'streaming' | 'complete' | 'stopped' | 'error'; error?: string };
export type Conversation = {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  errorReadAt?: number | null;
  messages: Message[];
};
export type ChatState = { conversations: Conversation[]; activeId: string | null; sidebarOpen: boolean };
type Action =
  | { type: 'select'; id: string | null }
  | { type: 'send'; conversationId: string; message: Message }
  | { type: 'reply'; conversationId: string; message: Message }
  | { type: 'rename'; id: string; title: string }
  | { type: 'pin'; id: string }
  | { type: 'fork'; conversationId: string; messageId: string; forkId: string; updatedAt: number }
  | { type: 'delete'; id: string }
  | { type: 'sidebar' };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'reply':
      return { ...state, conversations: state.conversations.map((conversation) => {
        if (conversation.id !== action.conversationId) return conversation;
        const exists = conversation.messages.some((message) => message.id === action.message.id);
        const next = { ...conversation, updatedAt: Date.now(), messages: exists
          ? conversation.messages.map((message) => message.id === action.message.id ? action.message : message)
          : [...conversation.messages, action.message] };
        if (action.message.status === 'error') next.errorReadAt = state.activeId === conversation.id ? Date.now() : null;
        else if (action.message.status === 'streaming') next.errorReadAt = null;
        else if (action.message.status === 'complete') delete next.errorReadAt;
        return next;
      }) };
    case 'select':
      return { ...state, activeId: action.id, conversations: state.conversations.map((conversation) => {
        const last = conversation.messages.at(-1);
        if (conversation.id !== action.id || last?.role !== 'assistant' || last.status !== 'error' || conversation.errorReadAt != null) return conversation;
        return { ...conversation, errorReadAt: Date.now() };
      }) };
    case 'sidebar':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'delete':
      return {
        ...state,
        conversations: state.conversations.filter((item) => item.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
      };
    case 'rename':
      if (!action.title.trim()) return state;
      return { ...state, conversations: state.conversations.map((item) =>
        item.id === action.id ? { ...item, title: action.title.trim() } : item) };
    case 'pin':
      return { ...state, conversations: state.conversations.map((item) =>
        item.id === action.id ? { ...item, pinned: !item.pinned } : item) };
    case 'fork': {
      const source = state.conversations.find((item) => item.id === action.conversationId);
      const messageIndex = source?.messages.findIndex((message) => message.id === action.messageId) ?? -1;
      if (!source || messageIndex < 0 || source.messages[messageIndex].role !== 'assistant'
        || state.conversations.some((item) => item.id === action.forkId)) return state;
      const branch: Conversation = {
        id: action.forkId,
        title: `${source.title} · 分支`,
        pinned: false,
        updatedAt: action.updatedAt,
        messages: source.messages.slice(0, messageIndex + 1).map((message, index) => ({ ...message, id: `${action.forkId}-${index + 1}` })),
      };
      return { ...state, activeId: branch.id, conversations: [branch, ...state.conversations] };
    }
    case 'send': {
      const current = state.conversations.find((item) => item.id === action.conversationId);
      const conversation: Conversation = current
        ? { ...current, messages: [...current.messages, action.message], updatedAt: Date.now() }
        : {
            id: action.conversationId,
            title: action.message.content.replace(/\s+/g, ' ').slice(0, 32),
            pinned: false,
            updatedAt: Date.now(),
            messages: [action.message],
          };
      delete conversation.errorReadAt;
      return {
        ...state,
        activeId: conversation.id,
        conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
      };
    }
  }
}

function useChatState(initialState?: ChatState) {
  const [state, dispatch] = useReducer(reducer, initialState ?? { conversations: [], activeId: null, sidebarOpen: true });
  return useMemo(() => ({ ...state, dispatch }), [state]);
}
const ChatContext = createContext<ReturnType<typeof useChatState> | null>(null);

export function ChatProvider({ children, initialState }: PropsWithChildren<{ initialState?: ChatState }>) {
  return <ChatContext value={useChatState(initialState)}>{children}</ChatContext>;
}

export function useChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('ChatProvider is required');
  return value;
}
