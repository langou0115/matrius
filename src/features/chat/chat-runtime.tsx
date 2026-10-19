import { createContext, useContext, useEffect, useState, useSyncExternalStore, type PropsWithChildren } from 'react';

import { createAgentRuntime } from '@/core/agent/runtime';
import { buildRetryHistory } from '@/core/agent/context';
import { withoutFailedTurn } from '@/core/agent/history';
import type { ThinkingEffort } from '@/core/agent/thinking-effort';
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

  function start(conversationId: string, history: Message[], replyId: string, thinkingEffort: ThinkingEffort) {
    const config = models.ready ? models.selected : undefined;
    return agent.start({
      conversationId, replyId, messages: history, config,
      apiKey: config?.requiresApiKey ? models.getKey(config.providerId) : '',
      thinkingEffort, systemPrompt: buildSystemPrompt(preferences),
    });
  }

  return {
    runningId, startedAt, error, clearError: agent.clearError, stop: agent.stop,
    send(content: string, existingId: string | null, thinkingEffort: ThinkingEffort = 'default', images: MessageImage[] = [], quote?: string) {
      const conversationId = existingId ?? createId();
      const current = conversations.find((item) => item.id === conversationId);
      const message: Message = { id: createId(), role: 'user', content, ...(images.length ? { images } : {}), ...(quote?.trim() ? { quote: quote.trim() } : {}) };
      // start schedules work on a microtask; dispatch user before any reply update.
      // Sending a new message supersedes a failed turn, so neither its question nor its error report
      // is part of the conversation the model continues from.
      if (!start(conversationId, [...withoutFailedTurn(current?.messages ?? []), message], createId(), thinkingEffort)) return false;
      dispatch({ type: 'send', conversationId, message, thinkingEffort });
      return true;
    },
    retry(conversationId: string, thinkingEffort?: ThinkingEffort) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const last = conversation?.messages.at(-1);
      if (!conversation || !last || (last.role === 'assistant' && last.status !== 'error' && last.status !== 'stopped')) return;
      if ((last.role === 'assistant' ? conversation.messages.at(-2) : last)?.role !== 'user') return;
      const history = buildRetryHistory(conversation.messages);
      start(conversationId, history, last.role === 'assistant' ? last.id : createId(), thinkingEffort ?? conversation.thinkingEffort ?? 'default');
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
