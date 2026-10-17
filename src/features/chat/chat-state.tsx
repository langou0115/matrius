import { createContext, useContext, useMemo, useReducer, type PropsWithChildren } from 'react';
import type { ThinkingEffort } from '@/core/agent/thinking-effort';

/** An image to send with a user message. It lives in memory only: the workspace snapshot drops
    `images` before writing, so a reload keeps the text and forgets the picture. */
export type MessageImage = { id: string; name: string; mimeType: string; dataUrl: string };
/** How long the model spent reasoning, measured to its last thinking token. Persisted so the
    finished reply still reports it after a reload. Absent when the model produced no reasoning. */
export type Message = { id: string; role: 'user' | 'assistant'; content: string; images?: MessageImage[]; reasoning?: string; reasoningActive?: boolean; thinkingMs?: number; status?: 'streaming' | 'complete' | 'stopped' | 'error'; error?: string };
export type Conversation = {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  thinkingEffort?: ThinkingEffort;
  errorReadAt?: number | null;
  messages: Message[];
};
export type ChatState = { conversations: Conversation[]; activeId: string | null; sidebarOpen: boolean; lastThinkingEffort: ThinkingEffort };
type Action =
  | { type: 'select'; id: string | null }
  | { type: 'send'; conversationId: string; message: Message; thinkingEffort: ThinkingEffort }
  | { type: 'thinking-effort'; conversationId: string | null; thinkingEffort: ThinkingEffort }
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
      return { ...state, activeId: action.id,
        lastThinkingEffort: state.conversations.find((conversation) => conversation.id === action.id)?.thinkingEffort ?? state.lastThinkingEffort,
        conversations: state.conversations.map((conversation) => {
        const last = conversation.messages.at(-1);
        if (conversation.id !== action.id || last?.role !== 'assistant' || last.status !== 'error' || conversation.errorReadAt != null) return conversation;
        return { ...conversation, errorReadAt: Date.now() };
      }) };
    case 'sidebar':
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case 'thinking-effort':
      return { ...state, lastThinkingEffort: action.thinkingEffort, conversations: state.conversations.map((conversation) => conversation.id === action.conversationId
        ? { ...conversation, thinkingEffort: action.thinkingEffort }
        : conversation) };
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
        thinkingEffort: source.thinkingEffort ?? state.lastThinkingEffort,
        messages: source.messages.slice(0, messageIndex + 1).map((message, index) => ({ ...message, id: `${action.forkId}-${index + 1}` })),
      };
      return { ...state, activeId: branch.id, lastThinkingEffort: branch.thinkingEffort ?? state.lastThinkingEffort, conversations: [branch, ...state.conversations] };
    }
    case 'send': {
      const current = state.conversations.find((item) => item.id === action.conversationId);
      const conversation: Conversation = current
        ? { ...current, thinkingEffort: action.thinkingEffort, messages: [...current.messages, action.message], updatedAt: Date.now() }
        : {
            id: action.conversationId,
            title: action.message.content.replace(/\s+/g, ' ').trim().slice(0, 32) || (action.message.images?.length ? '图片对话' : '新对话'),
            pinned: false,
            updatedAt: Date.now(),
            thinkingEffort: action.thinkingEffort,
            messages: [action.message],
          };
      delete conversation.errorReadAt;
      return {
        ...state,
        lastThinkingEffort: action.thinkingEffort,
        activeId: conversation.id,
        conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
      };
    }
  }
}

function initializeChatState(initialState?: ChatState): ChatState {
  if (!initialState) return { conversations: [], activeId: null, sidebarOpen: true, lastThinkingEffort: 'default' };
  const activeId = initialState.conversations.some((conversation) => conversation.id === initialState.activeId) ? initialState.activeId : null;
  return { ...initialState, activeId, lastThinkingEffort: initialState.lastThinkingEffort ?? initialState.conversations.find((conversation) => conversation.id === activeId)?.thinkingEffort ?? 'default' };
}

function useChatState(initialState?: ChatState) {
  const [state, dispatch] = useReducer(reducer, initialState, initializeChatState);
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
