import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from 'react';

import { createAgentRuntime } from '@/core/agent/runtime';
import { buildRetryHistory } from '@/core/agent/context';
import { withoutFailedTurn } from '@/core/agent/history';
import { useModels } from '@/features/models/model-state';
import { usePersonalization } from '@/features/settings/personalization-state';
import { buildSystemPrompt } from '@/core/agent/system-prompt';
import { useChat, type Message, type MessageImage } from './chat-state';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function useRuntime() {
  const { conversations, dispatch } = useChat();
  const models = useModels();
  const { preferences } = usePersonalization();
  const [agent] = useState(() => createAgentRuntime({
    onReply: (conversationId, message) => dispatch({ type: 'reply', conversationId, message }),
  }));
  const { runningId, startedAt, error } = useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);
  useEffect(() => () => agent.stop(), [agent]);
  useEffect(() => {
    if (runningId && !conversations.some((item) => item.id === runningId)) agent.stop();
  }, [agent, conversations, runningId]);

  // A conversation keeps the model it was started with. If that model has since been removed,
  // fall back to the most recently used one instead of failing the request.
  function resolveModel(modelId?: string) {
    if (!models.ready) return undefined;
    return (modelId ? models.models.find((item) => item.id === modelId) : undefined) ?? models.selected;
  }

  function start(conversationId: string, history: Message[], replyId: string, modelId?: string) {
    const config = resolveModel(modelId);
    const started = agent.start({
      conversationId, replyId, messages: history, config,
      apiKey: config?.requiresApiKey ? models.getKey(config.providerId) : '',
      // Thinking depth belongs to the model, so the bound model carries its own depth.
      thinkingEffort: config?.thinkingEffort ?? 'default', systemPrompt: buildSystemPrompt(preferences),
    });
    return started ? config : undefined;
  }

  return {
    runningId, startedAt, error, clearError: agent.clearError, stop: agent.stop,
    send(content: string, existingId: string | null, images: MessageImage[] = [], quote?: string) {
      const conversationId = existingId ?? createId();
      const current = conversations.find((item) => item.id === conversationId);
      const message: Message = { id: createId(), role: 'user', content, ...(images.length ? { images } : {}), ...(quote?.trim() ? { quote: quote.trim() } : {}) };
      // start schedules work on a microtask; dispatch user before any reply update.
      // Sending a new message supersedes a failed turn, so neither its question nor its error report
      // is part of the conversation the model continues from.
      const config = start(conversationId, [...withoutFailedTurn(current?.messages ?? []), message], createId(), current?.modelId);
      if (!config) return false;
      // Record the model on the conversation, so reopening it restores the same one. New
      // conversations bind to whichever model was used most recently.
      dispatch({ type: 'send', conversationId, message, modelId: config.id });
      return true;
    },
    retry(conversationId: string) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const last = conversation?.messages.at(-1);
      if (!conversation || !last || (last.role === 'assistant' && last.status !== 'error' && last.status !== 'stopped')) return;
      if ((last.role === 'assistant' ? conversation.messages.at(-2) : last)?.role !== 'user') return;
      const history = buildRetryHistory(conversation.messages);
      const config = start(conversationId, history, last.role === 'assistant' ? last.id : createId(), conversation.modelId);
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
