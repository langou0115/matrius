import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';

import { createAgentRuntime } from '@/core/agent/runtime';
import { buildRetryHistory } from '@/core/agent/context';
import { createFileTool, fileToolsSystemPrompt } from '@/core/agent/file-tools';
import { generateMemorySummary } from '@/core/agent/memory';
import { generateConversationTitle } from '@/core/agent/title';
import type { MessageFile, SteerOutcome } from '@/core/agent/types';
import { createWebTools, webToolsSystemPrompt } from '@/core/agent/web-tools';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { hasFeature } from '@/core/features/capabilities';
import type { ModelConfig } from '@/core/llm/model-config';
import { useModels } from '@/features/models/model-state';
import { useMemory } from '@/features/memory/memory-state';
import { pickMemoryModel } from '@/features/memory/memory-model';
import { usePersonalization } from '@/features/settings/personalization-state';
import { recordTokenUsage } from '@/features/usage/usage-api';
import { buildSystemPrompt } from '@/core/agent/system-prompt';
import { protectBrowserRun } from '@/core/platform/run-protection';
import { useInstance } from '@/features/instance/instance-state';
import { useNetworkTools } from '@/features/instance/network-tools-state';
import { deriveConversationTitle, useChat, type Conversation, type Message, type MessageImage } from './chat-state';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
// Stable empty value so rendering never sees a fresh array on every call.
const NO_MESSAGES: Message[] = [];
const MAX_ATTACHED_FILES = 30;

/** Every file the conversation has referenced, newest last, for the model's `list`/read calls. */
function collectAvailableFiles(messages: Message[]): MessageFile[] {
  const byId = new Map<string, MessageFile>();
  for (const message of messages) {
    for (const file of message.files ?? []) {
      const previous = byId.get(file.id);
      // A later message may carry a newer revision of the same file.
      byId.set(file.id, { ...previous, ...file });
    }
  }
  return [...byId.values()].slice(-MAX_ATTACHED_FILES);
}

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
  const memory = useMemory();
  const instance = useInstance();
  const networkTools = useNetworkTools();
  const [notifications, setNotifications] = useState<BackgroundNotification[]>([]);
  // The reply callback is created once, so it reads the latest view from refs instead of
  // closing over the first render's values.
  const activeIdRef = useRef(activeId);
  const chatVisibleRef = useRef(chatVisible);
  const conversationsRef = useRef(conversations);
  const modelsRef = useRef(models);
  const instanceRef = useRef(instance);
  const memoryRef = useRef(memory);
  const memoryAbort = useRef<AbortController | null>(null);
  const memoryChain = useRef(Promise.resolve());
  const lastMemoryUpdateAt = useRef(new Map<string, number>());
  // Title requests run beside the reply, so each conversation keeps at most one in flight.
  const titleControllers = useRef(new Map<string, AbortController>());
  // Guards against two synchronous sends from the same empty screen creating two chats.
  const newConversationLock = useRef(false);
  // Supplements sent after the answer started streaming. They stay here, not in the
  // conversation, until the run ends and they become the next ordinary turn.
  const pendingSends = useRef(new Map<string, Message[]>());
  const [pendingVersion, pendingChanged] = useReducer((value: number) => value + 1, 0);

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
  /** Long-term memory is consolidated at most once per conversation per minute, and only
      for a finished reply with actual text. The assistant itself never waits for it. */
  function scheduleMemoryUpdate(conversation: Conversation, reply: Message) {
    const state = memoryRef.current;
    if (!state.enabled) return;
    if (!reply.content.trim()) return;
    const now = Date.now();
    if (now - (lastMemoryUpdateAt.current.get(conversation.id) ?? 0) < 60_000) return;
    const messages = [...conversation.messages];
    const index = messages.findIndex((item) => item.id === reply.id);
    if (index >= 0) messages[index] = reply;
    else messages.push(reply);
    const user = [...messages].reverse().find((item) => item.role === 'user' && !item.steering);
    const userMessage = user ? user.content.trim() || user.quote?.trim() || '' : '';
    if (!userMessage) return;
    lastMemoryUpdateAt.current.set(conversation.id, now);
    const task = {
      conversationId: conversation.id,
      modelId: conversation.modelId,
      userMessage,
      assistantMessage: reply.content,
    };
    memoryChain.current = memoryChain.current.then(async () => {
      const current = memoryRef.current;
      if (!current.enabled) return;
      const config = pickMemoryModel(modelsRef.current, task.modelId);
      if (!config) return;
      const apiKey = config.requiresApiKey ? modelsRef.current.getKey(config.providerId) : '';
      const controller = new AbortController();
      memoryAbort.current = controller;
      const baseSummary = current.summary;
      const baseRevision = current.revision;
      try {
        const updated = await generateMemorySummary({
          config, apiKey, currentSummary: baseSummary,
          userMessage: task.userMessage, assistantMessage: task.assistantMessage,
          signal: controller.signal,
        });
        const latest = memoryRef.current;
        // A manual edit or clear during the request wins over the background result.
        if (!latest.enabled || latest.revision !== baseRevision || latest.summary !== baseSummary) return;
        if (updated === null || updated === baseSummary.trim()) return;
        latest.replaceSummary(updated);
      } catch {
        // Memory is an enhancement: a provider error must not surface in the conversation.
      } finally {
        if (memoryAbort.current === controller) memoryAbort.current = null;
      }
    }).catch(() => {});
  }
  // eslint-disable-next-line react-hooks/refs -- the callback reads these refs when a reply arrives, not during render
  const [agent] = useState(() => createAgentRuntime({
    // Compaction is invisible, so the summary only travels into the conversation record.
    onSummary: (conversationId, summary) => dispatch({ type: 'context-summary', conversationId, summary }),
    // Token statistics are recorded by the authenticated instance.
    onUsage: (usage) => {
      const current = instanceRef.current;
      if (current.status !== 'ready' || !hasFeature(current.info, 'usage')) return;
      void recordTokenUsage(current.request, usage).catch(() => {
        // Best effort: a failed report never interrupts or retries the conversation.
      });
    },
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
          if (first && (first.content.trim() || first.quote?.trim() || first.files?.length)) requestTitle(conversationId, first.content, first.quote,
            modelsRef.current.titleModel ?? pickModel(modelsRef.current, conversation.modelId), deriveConversationTitle(first));
        }
        if (conversation) scheduleMemoryUpdate(conversation, message);
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
  const { runs, error, contexts } = useSyncExternalStore(agent.subscribe, agent.getSnapshot, agent.getSnapshot);

  // A conversation keeps the model it was started with. If that model has since been removed,
  // fall back to the most recently used one instead of failing the request.
  const start = useCallback((conversationId: string, history: Message[], replyId: string, modelId?: string,
    contextSummary?: Conversation['contextSummary']) => {
    const config = pickModel(models, modelId);
    // Web tools require the instance connection; the preference is only known
    // after it loads, so the first reply waits for `ready` instead of guessing.
    const useWebTools = networkTools.ready && networkTools.enabled;
    const useFileTools = hasFeature(instance.status === 'ready' ? instance.info : null, 'files');
    const tools: AgentTool[] = [];
    if (useWebTools) tools.push(...createWebTools(instance.request));
    if (useFileTools) {
      tools.push(createFileTool({
        request: instance.request, conversationId, availableFiles: collectAvailableFiles(history),
      }).tool);
    }
    const prompts = [buildSystemPrompt(preferences, memoryRef.current)];
    if (useWebTools) prompts.push(webToolsSystemPrompt());
    if (useFileTools) prompts.push(fileToolsSystemPrompt());
    const started = agent.start({
      conversationId, replyId, messages: history, config,
      ...(contextSummary ? { contextSummary } : {}),
      apiKey: config?.requiresApiKey ? models.getKey(config.providerId) : '',
      // Thinking depth belongs to the model, so the bound model carries its own depth.
      thinkingEffort: config?.thinkingEffort ?? 'low',
      systemPrompt: prompts.join('\n\n'),
      ...(tools.length ? { tools } : {}),
    });
    return started ? config : undefined;
  }, [agent, instance, models, networkTools, preferences]);

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
    instanceRef.current = instance;
    memoryRef.current = memory;
  });

  useEffect(() => () => {
    agent.stop();
    titleControllers.current.forEach((controller) => controller.abort());
    titleControllers.current.clear();
    memoryAbort.current?.abort();
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
    for (const conversationId of [...pendingSends.current.keys()]) {
      if (!existing.has(conversationId)) pendingSends.current.delete(conversationId);
    }
  }, [agent, conversations, runs]);
  // A queued supplement starts its own run once the previous one ends. Writing it to the
  // conversation only now keeps the saved order as [finished reply, supplement].
  useEffect(() => {
    if (!models.ready) return;
    let changed = false;
    for (const [conversationId, pending] of pendingSends.current) {
      if (!pending.length) continue;
      // The rendered snapshot and the runtime can disagree for one tick; check both so a
      // supplement never starts a second concurrent run.
      if (runs[conversationId] || agent.getSnapshot().runs[conversationId]) continue;
      const conversation = conversations.find((item) => item.id === conversationId);
      if (!conversation) { pendingSends.current.delete(conversationId); changed = true; continue; }
      // Drop the queue before starting: a rejected start must not retry forever.
      pendingSends.current.delete(conversationId);
      changed = true;
      const replyId = createId();
      const config = start(conversationId, [...conversation.messages, ...pending], replyId, conversation.modelId,
        conversation.contextSummary);
      for (const message of pending) dispatch({ type: 'append-user', conversationId, message });
      if (config) dispatch({ type: 'reply', conversationId, message: { id: replyId, role: 'assistant', content: '', status: 'streaming' } });
    }
    if (changed) pendingChanged();
  }, [agent, conversations, dispatch, models.ready, pendingVersion, runs, start]);

  // Stable so each card's auto-dismiss timer is not restarted by unrelated stream updates.
  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  return {
    runs, error, contexts, clearError: agent.clearError,
    isRunning: (conversationId: string | null | undefined) => !!conversationId && !!runs[conversationId],
    isAnyRunning: Object.keys(runs).length > 0,
    stop: agent.stop,
    notifications, dismissNotification,
    send(content: string, existingId: string | null, images: MessageImage[] = [], quote?: string,
      files: MessageFile[] = []) {
      if (existingId === null && newConversationLock.current) return false;
      const conversationId = existingId ?? createId();
      const current = conversations.find((item) => item.id === conversationId);
      // A manual send can beat the effect that drains the queue after a run ends. Carry those
      // messages into the same request so their order and context stay correct.
      const queued = (existingId ? pendingSends.current.get(existingId) : undefined) ?? NO_MESSAGES;
      // The real UI always passes a fresh id for a new chat, so use the history rather than
      // `existingId === null` to recognise the first message.
      const isFirstMessage = !current || current.messages.length === 0;
      const message: Message = { id: createId(), role: 'user', content, ...(images.length ? { images } : {}),
        ...(files.length ? { files, fileIds: files.map((file) => file.id) } : {}),
        ...(quote?.trim() ? { quote: quote.trim() } : {}) };
      // start schedules work on a microtask; dispatch user before any reply update.
      // Keep the user's question and partial reply available for follow-ups such as “continue”.
      const config = start(conversationId, [...(current?.messages ?? []), ...queued, message], createId(),
        current?.modelId, current?.contextSummary);
      if (!config) return false;
      if (existingId === null) newConversationLock.current = true;
      if (queued.length) {
        pendingSends.current.delete(conversationId);
        // Append in send order before the new message, which the `send` action adds last.
        for (const item of queued) dispatch({ type: 'append-user', conversationId, message: item });
        pendingChanged();
      }
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
    pendingMessages(conversationId: string | null | undefined): Message[] {
      return (conversationId ? pendingSends.current.get(conversationId) : undefined) ?? NO_MESSAGES;
    },
    /** Adds a supplement to the active run. False means there is no run to steer. */
    steer(content: string, conversationId: string, images: MessageImage[] = [], quote?: string,
      files: MessageFile[] = []): SteerOutcome {
      const message: Message = { id: createId(), role: 'user', content,
        ...(images.length ? { images } : {}),
        ...(files.length ? { files, fileIds: files.map((file) => file.id) } : {}),
        ...(quote?.trim() ? { quote: quote.trim() } : {}) };
      const outcome = agent.steer(conversationId, message);
      if (!outcome) return false;
      if (outcome === 'deferred') {
        // Keep it out of the conversation until the run ends, but show it immediately above
        // the streaming reply through `pendingMessages`.
        pendingSends.current.set(conversationId, [...(pendingSends.current.get(conversationId) ?? NO_MESSAGES), message]);
        pendingChanged();
        return outcome;
      }
      const replyId = agent.getSnapshot().runs[conversationId]?.replyId;
      dispatch({ type: 'steer', conversationId, message: { ...message, steering: true }, ...(replyId ? { replyId } : {}) });
      return outcome;
    },
    retry(conversationId: string) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const last = conversation?.messages.at(-1);
      if (!conversation || !last || (last.role === 'assistant' && last.status !== 'error' && last.status !== 'stopped')) return;
      if ((last.role === 'assistant' ? conversation.messages.at(-2) : last)?.role !== 'user') return;
      const history = buildRetryHistory(conversation.messages);
      const replyId = last.role === 'assistant' ? last.id : createId();
      const config = start(conversationId, history, replyId, conversation.modelId, conversation.contextSummary);
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
