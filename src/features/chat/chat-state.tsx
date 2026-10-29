import { createContext, useContext, useMemo, useReducer, type PropsWithChildren } from 'react';
import type { ConversationSummary } from '@/core/agent/compaction';
import type { Message, MessageFeedback } from '@/core/agent/types';
import { normalizeConversationTitle } from '@/core/agent/title';
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
  /** Rolling summary of older turns, persisted with the conversation and synced with it. */
  contextSummary?: ConversationSummary;
  messages: Message[];
};

/** The fallback shown until a title request succeeds, and the value a late result may replace. */
export function deriveConversationTitle(message: Pick<Message, 'content' | 'images' | 'fileIds' | 'files'>): string {
  return normalizeConversationTitle(message.content.replace(/\s+/g, ' ').trim())
    || (message.images?.length ? '图片对话' : message.files?.length || message.fileIds?.length ? '文件对话' : '新对话');
}
export type ChatState = { conversations: Conversation[]; deletedConversationIds?: string[]; activeId: string | null; sidebarOpen: boolean; chatVisible: boolean };
/** Visibility is a per-tab concern, so it is kept out of the persisted workspace. */
export type PersistedChatState = Omit<ChatState, 'chatVisible'>;
type Action =
  | { type: 'select'; id: string | null }
  | { type: 'send'; conversationId: string; message: Message; modelId?: string }
  | { type: 'steer'; conversationId: string; message: Message; replyId?: string }
  | { type: 'append-user'; conversationId: string; message: Message }
  | { type: 'bind-model'; conversationId: string; modelId: string }
  | { type: 'reply'; conversationId: string; message: Message }
  | { type: 'context-summary'; conversationId: string; summary?: ConversationSummary }
  | { type: 'feedback'; conversationId: string; messageId: string; feedback?: MessageFeedback }
  | { type: 'rename'; id: string; title: string }
  | { type: 'auto-title'; conversationId: string; title: string; from: string }
  | { type: 'pin'; id: string }
  | { type: 'fork'; conversationId: string; messageId: string; forkId: string; updatedAt: number }
  | { type: 'delete'; id: string }
  | { type: 'merge-sync'; conversations: Conversation[]; deletedConversationIds?: string[] }
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
          delete next.errorReadAt;
          delete next.completedReadAt;
        }
        return next;
      }) };
    case 'context-summary':
      return { ...state, conversations: state.conversations.map((conversation) => {
        if (conversation.id !== action.conversationId) return conversation;
        if (JSON.stringify(conversation.contextSummary) === JSON.stringify(action.summary)) return conversation;
        // The summary is metadata, not a new turn: keep `updatedAt` for message ordering.
        const { contextSummary, ...rest } = conversation;
        return action.summary ? { ...rest, contextSummary: action.summary } : rest;
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
        deletedConversationIds: [...new Set([...(state.deletedConversationIds ?? []), action.id])],
        conversations: state.conversations.filter((item) => item.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
      };
    case 'merge-sync': {
      const deleted = new Set([...(state.deletedConversationIds ?? []), ...(action.deletedConversationIds ?? [])]);
      if (action.deletedConversationIds?.length) {
        state = { ...state, deletedConversationIds: [...deleted],
          conversations: state.conversations.filter((item) => !deleted.has(item.id)),
          activeId: state.activeId && deleted.has(state.activeId) ? null : state.activeId };
      }
      if (!action.conversations.length) return state;
      const incoming = new Map(action.conversations.filter((conversation) => !deleted.has(conversation.id)).map((conversation) => [conversation.id, conversation]));
      let changed = false;
      const conversations = state.conversations.map((conversation) => {
        const next = incoming.get(conversation.id);
        if (!next) return conversation;
        incoming.delete(conversation.id);
        // A sync response was built from an older snapshot. It must never replace
        // a live stream, or a message the user changed while the request was away.
        if (conversation.messages.some((message) => message.status === 'streaming')
          || conversation.updatedAt > next.updatedAt) return conversation;
        if (JSON.stringify(next) === JSON.stringify(conversation)) return conversation;
        changed = true;
        return next;
      });
      const additions = [...incoming.values()];
      if (additions.length) changed = true;
      return changed ? { ...state, conversations: [...additions, ...conversations] } : state;
    }
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
    case 'steer':
      return { ...state, conversations: state.conversations.map((conversation) => {
        if (conversation.id !== action.conversationId) return conversation;
        // The reply is already visible while streaming, so the supplement belongs in front
        // of it. If it has not arrived yet, appending is the same visual order.
        const index = action.replyId
          ? conversation.messages.findIndex((message) => message.id === action.replyId)
          : -1;
        const messages = index < 0
          ? [...conversation.messages, action.message]
          : [...conversation.messages.slice(0, index), action.message, ...conversation.messages.slice(index)];
        return { ...conversation, messages, updatedAt: Date.now() };
      }) };
    case 'append-user':
      return { ...state, conversations: state.conversations.map((conversation) => conversation.id === action.conversationId
        // A queued message is already being carried into a new run: append it after the finished
        // reply without changing the active chat or the unread markers.
        ? { ...conversation, messages: [...conversation.messages, action.message], updatedAt: Date.now() }
        : conversation) };
    case 'send': {
      const current = state.conversations.find((item) => item.id === action.conversationId);
      const modelId = action.modelId ?? current?.modelId;
      const conversation: Conversation = current
        ? { ...current, ...(modelId ? { modelId } : {}), messages: [...current.messages, action.message], updatedAt: Date.now() }
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
