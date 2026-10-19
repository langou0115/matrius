import { createContext, useContext, useMemo, useReducer, type PropsWithChildren } from 'react';
import { withoutFailedTurn } from '@/core/agent/history';
import type { Message, MessageFeedback } from '@/core/agent/types';
export type { Message, MessageImage } from '@/core/agent/types';

export type Conversation = {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: number;
  /** The model this conversation was last bound to; absent on conversations from older versions. */
  modelId?: string;
  errorReadAt?: number | null;
  /** null means a reply finished while the reader was elsewhere; cleared once they see it. */
  completedReadAt?: number | null;
  /** `auto` waits for an AI title, `ai` already has one, `manual` must never be overwritten. */
  titleSource?: 'auto' | 'ai' | 'manual';
  messages: Message[];
};

/** The fallback shown until a title request succeeds, and the value a late result may replace. */
export function deriveConversationTitle(message: Pick<Message, 'content' | 'images'>): string {
  return message.content.replace(/\s+/g, ' ').trim().slice(0, 32)
    || (message.images?.length ? '图片对话' : '新对话');
}
export type ChatState = { conversations: Conversation[]; activeId: string | null; sidebarOpen: boolean; chatVisible: boolean };
/** Visibility is a per-tab concern, so it is kept out of the persisted workspace. */
export type PersistedChatState = Omit<ChatState, 'chatVisible'>;
type Action =
  | { type: 'select'; id: string | null }
  | { type: 'send'; conversationId: string; message: Message; modelId?: string }
  | { type: 'bind-model'; conversationId: string; modelId: string }
  | { type: 'reply'; conversationId: string; message: Message }
  | { type: 'feedback'; conversationId: string; messageId: string; feedback?: MessageFeedback }
  | { type: 'rename'; id: string; title: string }
  | { type: 'auto-title'; conversationId: string; title: string; from: string }
  | { type: 'pin'; id: string }
  | { type: 'fork'; conversationId: string; messageId: string; forkId: string; updatedAt: number }
  | { type: 'delete'; id: string }
  | { type: 'visible'; value: boolean }
  | { type: 'sidebar' };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'feedback':
      return { ...state, conversations: state.conversations.map((conversation) => conversation.id !== action.conversationId ? conversation : {
        ...conversation,
        messages: conversation.messages.map((message) => {
          if (message.id !== action.messageId || message.role !== 'assistant' || message.status === 'streaming') return message;
          const { feedback, ...rest } = message;
          return action.feedback ? { ...rest, feedback: action.feedback } : rest;
        }),
      }) };
    case 'reply':
      return { ...state, conversations: state.conversations.map((conversation) => {
        if (conversation.id !== action.conversationId) return conversation;
        const exists = conversation.messages.some((message) => message.id === action.message.id);
        const next = { ...conversation, updatedAt: Date.now(), messages: exists
          ? conversation.messages.map((message) => message.id === action.message.id ? action.message : message)
          : [...conversation.messages, action.message] };
        if (action.message.status === 'error') {
          next.errorReadAt = state.activeId === conversation.id ? Date.now() : null;
          delete next.completedReadAt;
        } else if (action.message.status === 'streaming') {
          next.errorReadAt = null;
          delete next.completedReadAt;
        } else if (action.message.status === 'complete') {
          delete next.errorReadAt;
          // Only a reply the reader can see clears the marker; otherwise it stays unread
          // until the conversation is opened. Settings counts as away even if activeId matches.
          if (state.chatVisible && state.activeId === conversation.id) delete next.completedReadAt;
          else next.completedReadAt = null;
        } else if (action.message.status === 'stopped') {
          delete next.completedReadAt;
        }
        return next;
      }) };
    case 'select':
      return { ...state, activeId: action.id,
        conversations: state.conversations.map((conversation) => {
        if (conversation.id !== action.id) return conversation;
        let next = conversation;
        const last = conversation.messages.at(-1);
        if (last?.role === 'assistant' && last.status === 'error' && conversation.errorReadAt == null) next = { ...next, errorReadAt: Date.now() };
        if (next.completedReadAt !== undefined) { next = { ...next }; delete next.completedReadAt; }
        return next;
      }) };
    case 'visible': {
      if (!action.value) return state.chatVisible ? { ...state, chatVisible: false } : state;
      // Returning from a full-page route can leave activeId unchanged, so becoming visible
      // itself acknowledges whatever the open conversation accumulated while away.
      let changed = !state.chatVisible;
      const conversations = state.conversations.map((conversation) => {
        if (conversation.id !== state.activeId) return conversation;
        let next = conversation;
        if (next.completedReadAt !== undefined) { next = { ...next }; delete next.completedReadAt; changed = true; }
        const last = conversation.messages.at(-1);
        if (last?.role === 'assistant' && last.status === 'error' && conversation.errorReadAt == null) {
          next = { ...next, errorReadAt: Date.now() };
          changed = true;
        }
        return next;
      });
      return changed ? { ...state, chatVisible: true, conversations } : state;
    }
    case 'bind-model':
      return { ...state, conversations: state.conversations.map((conversation) => conversation.id === action.conversationId && conversation.modelId !== action.modelId
        ? { ...conversation, modelId: action.modelId }
        : conversation) };
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
        item.id === action.id ? { ...item, title: action.title.trim(), titleSource: 'manual' } : item) };
    case 'auto-title': {
      const title = action.title.trim();
      if (!title) return state;
      let changed = false;
      const conversations = state.conversations.map((conversation) => {
        // A manual rename wins even when the generated title happens to be identical to the fallback.
        if (conversation.id !== action.conversationId || conversation.titleSource !== 'auto' || conversation.title !== action.from) return conversation;
        changed = true;
        return { ...conversation, title, titleSource: 'ai' as const };
      });
      return changed ? { ...state, conversations } : state;
    }
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
        ...(source.modelId ? { modelId: source.modelId } : {}),
        titleSource: 'manual',
        messages: source.messages.slice(0, messageIndex + 1).map((message, index) => ({ ...message, id: `${action.forkId}-${index + 1}` })),
      };
      return { ...state, activeId: branch.id, conversations: [branch, ...state.conversations] };
    }
    case 'send': {
      const current = state.conversations.find((item) => item.id === action.conversationId);
      // Sending a new message supersedes a failed turn: the unanswered question and its error
      // report are both dropped, so the conversation history matches what was actually answered.
      const modelId = action.modelId ?? current?.modelId;
      const conversation: Conversation = current
        ? { ...current, ...(modelId ? { modelId } : {}), messages: [...withoutFailedTurn(current.messages), action.message], updatedAt: Date.now() }
        : {
            id: action.conversationId,
            title: deriveConversationTitle(action.message),
            titleSource: 'auto',
            pinned: false,
            updatedAt: Date.now(),
            ...(modelId ? { modelId } : {}),
            messages: [action.message],
          };
      delete conversation.errorReadAt;
      delete conversation.completedReadAt;
      return {
        ...state,
        activeId: conversation.id,
        conversations: [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)],
      };
    }
  }
}

function initializeChatState(initialState?: PersistedChatState): ChatState {
  if (!initialState) return { conversations: [], activeId: null, sidebarOpen: true, chatVisible: true };
  const activeId = initialState.conversations.some((conversation) => conversation.id === initialState.activeId) ? initialState.activeId : null;
  return { ...initialState, activeId, chatVisible: true };
}

function useChatState(initialState?: PersistedChatState) {
  const [state, dispatch] = useReducer(reducer, initialState, initializeChatState);
  return useMemo(() => ({ ...state, dispatch }), [state]);
}
const ChatContext = createContext<ReturnType<typeof useChatState> | null>(null);

export function ChatProvider({ children, initialState }: PropsWithChildren<{ initialState?: PersistedChatState }>) {
  return <ChatContext value={useChatState(initialState)}>{children}</ChatContext>;
}

export function useChat() {
  const value = useContext(ChatContext);
  if (!value) throw new Error('ChatProvider is required');
  return value;
}
