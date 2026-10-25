import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';

import { createAgentRuntime } from '@/core/agent/runtime';
import { buildRetryHistory } from '@/core/agent/context';
import { generateConversationTitle } from '@/core/agent/title';
import { createWebTools, webToolsSystemPrompt } from '@/core/agent/web-tools';
import type { ModelConfig } from '@/core/llm/model-config';
import { useModels } from '@/features/models/model-state';
import { usePersonalization } from '@/features/settings/personalization-state';
import { buildSystemPrompt } from '@/core/agent/system-prompt';
import { protectBrowserRun } from '@/core/platform/run-protection.web';
import { useAuth } from '@/features/auth/auth-state.web';
import { useNetworkTools } from '@/features/auth/network-tools-state.web';
import { deriveConversationTitle, useChat, type Message, type MessageImage } from './chat-state';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

type ModelsApi = ReturnType<typeof useModels>;

function pickModel(source: ModelsApi, modelId?: string) {
  if (!source.ready) return undefined;
  return (modelId ? source.models.find((item) => item.id === modelId) : undefined) ?? source.selected;
}

export type BackgroundNotification = {
  id: string;
  conversationId: string;
  title: string;
  preview: string;
  createdAt: number;
};

function useRuntime() {
  const { conversations, activeId, chatVisible, dispatch } = useChat();
  const models = useModels();
  const { preferences } = usePersonalization();
  const auth = useAuth();
  const networkTools = useNetworkTools();
  const [notifications, setNotifications] = useState<BackgroundNotification[]>([]);
  // The reply callback is created once, so it reads the latest view from refs instead of
  // closing over the first render's values.
  const activeIdRef = useRef(activeId);
  const chatVisibleRef = useRef(chatVisible);
  const conversationsRef = useRef(conversations);
  const modelsRef = useRef(models);
  // Title requests run beside the reply, so each conversation keeps at most one in flight.
  const titleControllers = useRef(new Map<string, AbortController>());
  // Guards against two synchronous sends from the same empty screen creating two chats.
  const newConversationLock = useRef(false);

  function requestTitle(conversationId: string, content: string, quote: string | undefined, config: ModelConfig | undefined, from: string) {
    if (!config || titleControllers.current.has(conversationId)) return;
    const controller = new AbortController();
    titleControllers.current.set(conversationId, controller);
    void generateConversationTitle({
      config, content, quote, signal: controller.signal,
      apiKey: config.requiresApiKey ? modelsRef.current.getKey(config.providerId) : '',
    }).then((title) => {
      if (!title || controller.signal.aborted) return;
      dispatch({ type: 'auto-title', conversationId, title, from });
    }).catch(() => {
      // Titles are optional: a failed request leaves the derived fallback in place.
    }).finally(() => {
      if (titleControllers.current.get(conversationId) === controller) titleControllers.current.delete(conversationId);
    });
  }
  // eslint-disable-next-line react-hooks/refs -- the callback reads these refs when a reply arrives, not during render
  const [agent] = useState(() => createAgentRuntime({
    onReply: (conversationId, message) => {
      dispatch({ type: 'reply', conversationId, message });
      // The first title attempt may have failed with the first reply. `titleSource` stays
      // `auto` until an AI title lands, so a later successful reply retries it once.
      if (message.status === 'complete') {
        const conversation = conversationsRef.current.find((item) => item.id === conversationId);
        if (conversation?.titleSource === 'auto') {
          // Only the conversation's opening message names it. An image-only opening keeps the
          // "图片对话" fallback instead of being retitled by a later text message.
          const first = conversation.messages.find((item) => item.role === 'user');
          if (first && (first.content.trim() || first.quote?.trim())) requestTitle(conversationId, first.content, first.quote,
            modelsRef.current.titleModel ?? pickModel(modelsRef.current, conversation.modelId), deriveConversationTitle(first));
        }
      }
      // Only a finished reply is worth announcing, and only when the reader is elsewhere:
      // another conversation or a full-page route such as settings.
      if (message.status !== 'complete') return;
      if (conversationId === activeIdRef.current && chatVisibleRef.current) return;
      const conversation = conversationsRef.current.find((item) => item.id === conversationId);
      if (!conversation) return;
      const preview = message.content.replace(/\s+/g, ' ').trim().slice(0, 120);
      const notification: BackgroundNotification = {
        id: `${conversationId}-${message.id}`,
        conversationId,
        title: conversation.title,
        preview: preview || '回复已完成。',
        createdAt: Date.now(),
      };
      setNotifications((current) => [
        notification,
        ...current.filter((item) => item.conversationId !== conversationId),
      ].slice(0, 3));
    },
  }));
  const { runs, error } = useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);

  useEffect(() => {
    const protection = protectBrowserRun();
    const update = () => protection.setActive(Object.keys(agent.getSnapshot().runs).length > 0);
    const unsubscribe = agent.subscribe(update);
    update();
    return () => { unsubscribe(); protection.dispose(); };
  }, [agent]);

  useEffect(() => {
    activeIdRef.current = activeId;
    chatVisibleRef.current = chatVisible;
    conversationsRef.current = conversations;
    modelsRef.current = models;
  });

  useEffect(() => () => {
    agent.stop();
    titleControllers.current.forEach((controller) => controller.abort());
    titleControllers.current.clear();
  }, [agent]);
  // Opening the conversation — or coming back from settings — leaves its card no work to do.
  useEffect(() => {
    if (!chatVisible || !activeId) return;
    // Deferred one task so dismissal follows the navigation commit instead of cascading
    // another render from inside the effect.
    const timer = setTimeout(() => {
      setNotifications((current) => current.some((item) => item.conversationId === activeId)
        ? current.filter((item) => item.conversationId !== activeId)
        : current);
    }, 0);
    return () => clearTimeout(timer);
  }, [activeId, chatVisible]);
  // Once the new conversation has reached state, a second synchronous send may create another.
  useEffect(() => {
    if (newConversationLock.current && conversations.some((item) => item.id === activeId)) newConversationLock.current = false;
  }, [conversations, activeId]);
  // Deleting a conversation cancels only that conversation's run and title request.
  useEffect(() => {
    const existing = new Set(conversations.map((item) => item.id));
    for (const conversationId of Object.keys(runs)) {
      if (!existing.has(conversationId)) agent.stop(conversationId);
    }
    for (const [conversationId, controller] of titleControllers.current) {
      if (existing.has(conversationId)) continue;
      controller.abort();
      titleControllers.current.delete(conversationId);
    }
  }, [agent, conversations, runs]);

  // A conversation keeps the model it was started with. If that model has since been removed,
  // fall back to the most recently used one instead of failing the request.
  function resolveModel(modelId?: string) {
    return pickModel(models, modelId);
  }

  function start(conversationId: string, history: Message[], replyId: string, modelId?: string) {
    const config = resolveModel(modelId);
    // Cloud tools require a usable account. The server enforces the same rule; this keeps an
    // anonymous or not-yet-ready session from advertising tools the model cannot call.
    const useWebTools = Boolean(auth.user && !auth.user.mustChangePassword
      && networkTools.ready && networkTools.enabled);
    const started = agent.start({
      conversationId, replyId, messages: history, config,
      apiKey: config?.requiresApiKey ? models.getKey(config.providerId) : '',
      // Thinking depth belongs to the model, so the bound model carries its own depth.
      thinkingEffort: config?.thinkingEffort ?? 'default',
      systemPrompt: useWebTools
        ? `${buildSystemPrompt(preferences)}\n\n${webToolsSystemPrompt()}`
        : buildSystemPrompt(preferences),
      ...(useWebTools ? { tools: createWebTools(auth.request) } : {}),
    });
    return started ? config : undefined;
  }

  // Stable so each card's auto-dismiss timer is not restarted by unrelated stream updates.
  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  return {
    runs, error, clearError: agent.clearError,
    isRunning: (conversationId: string | null | undefined) => !!conversationId && !!runs[conversationId],
    isAnyRunning: Object.keys(runs).length > 0,
    stop: agent.stop,
    notifications, dismissNotification,
    send(content: string, existingId: string | null, images: MessageImage[] = [], quote?: string) {
      if (existingId === null && newConversationLock.current) return false;
      const conversationId = existingId ?? createId();
      const current = conversations.find((item) => item.id === conversationId);
      // The real UI always passes a fresh id for a new chat, so use the history rather than
      // `existingId === null` to recognise the first message.
      const isFirstMessage = !current || current.messages.length === 0;
      const message: Message = { id: createId(), role: 'user', content, ...(images.length ? { images } : {}), ...(quote?.trim() ? { quote: quote.trim() } : {}) };
      // start schedules work on a microtask; dispatch user before any reply update.
      // Keep the user's question and partial reply available for follow-ups such as “continue”.
      const config = start(conversationId, [...(current?.messages ?? []), message], createId(), current?.modelId);
      if (!config) return false;
      if (existingId === null) newConversationLock.current = true;
      // Record the model on the conversation, so reopening it restores the same one. New
      // conversations bind to whichever model was used most recently.
      dispatch({ type: 'send', conversationId, message, modelId: config.id });
      if (isFirstMessage) {
        // Generate in parallel with the reply. A failure keeps the derived title and is retried
        // after the next successful reply (see onReply).
        requestTitle(conversationId, message.content, message.quote,
          models.titleModel ?? config, deriveConversationTitle(message));
      }
      return true;
    },
    retry(conversationId: string) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const last = conversation?.messages.at(-1);
      if (!conversation || !last || (last.role === 'assistant' && last.status !== 'error' && last.status !== 'stopped')) return;
      if ((last.role === 'assistant' ? conversation.messages.at(-2) : last)?.role !== 'user') return;
      const history = buildRetryHistory(conversation.messages);
      const replyId = last.role === 'assistant' ? last.id : createId();
      const config = start(conversationId, history, replyId, conversation.modelId);
      if (config) dispatch({ type: 'reply', conversationId,
        message: { id: replyId, role: 'assistant', content: '', status: 'streaming' } });
      if (config && conversation.modelId !== config.id) dispatch({ type: 'bind-model', conversationId, modelId: config.id });
    },
  };
}
const RuntimeContext = createContext<ReturnType<typeof useRuntime> | null>(null);
export function ChatRuntimeProvider({ children }: PropsWithChildren) { return <RuntimeContext value={useRuntime()}>{children}</RuntimeContext>; }
export function useChatRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('ChatRuntimeProvider is required');
  return value;
}
