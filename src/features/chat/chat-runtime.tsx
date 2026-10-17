import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';

import type { createReplyRun } from '@/core/agent/runner';
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
  const [runningId, setRunningId] = useState<string | null>(null);
  // Feeds the elapsed counter next to the reply; nothing else reads it, so it is not persisted.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<{ conversationId: string; abort: () => void } | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    if (active.current && !conversations.some((item) => item.id === active.current?.conversationId)) active.current.abort();
  }, [conversations]);

  function start(conversationId: string, history: Message[], replyId: string, thinkingEffort: ThinkingEffort) {
    const config = models.selected;
    if (!config || !models.ready) { setError('请先在设置 → 模型服务中添加并选择模型。'); return false; }
    if (active.current) return false;
    if (!config.supportsImage && history.some((message) => message.images?.length)) { setError('当前模型不支持此对话中的图片，请切换支持图片的模型。'); return false; }
    if (config.requiresApiKey && !models.getKey(config.providerId)) { setError('请在模型服务中填写当前服务商的 API key。'); return false; }
    // Conservative character estimate, leaving room for the output and system prompt. An image
    // costs roughly a thousand tokens regardless of its encoded size, so count it as 4000 chars.
    const systemPrompt = buildSystemPrompt(preferences);
    if (history.reduce((sum, item) => sum + item.content.length + (item.images?.length ?? 0) * 4000 + 32, systemPrompt.length) > config.contextWindow - config.maxOutput - 256) {
      setError('对话可能超出上下文窗口，请新建对话或在模型设置中调整窗口。'); return false;
    }
    const apiKey = config.requiresApiKey ? models.getKey(config.providerId) : '';
    const startedAtMs = Date.now();
    setError(null);
    setRunningId(conversationId);
    setStartedAt(startedAtMs);
    let latest: Message = { id: replyId, role: 'assistant', content: '', status: 'streaming' };
    let run: ReturnType<typeof createReplyRun> | undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastReasoning = '';
    let thinkingMs: number | undefined;
    const flush = () => { if (timer) clearTimeout(timer); timer = undefined; dispatch({ type: 'reply', conversationId, message: latest }); };
    const marker = { conversationId, abort() { cancelled = true; run?.abort(); } };
    active.current = marker;
    // Lazy import keeps provider SDKs out of the initial UI render.
    void import('@/core/agent/runner').then(async ({ createReplyRun }) => {
      if (cancelled) return { status: 'stopped' as const };
      run = createReplyRun({ config, apiKey, messages: history, thinkingEffort, systemPrompt, onUpdate(value) {
        // Stamped on every reasoning change, so the finished header reports how long the model
        // actually thought rather than how long the whole reply took. It stops advancing once
        // thinking stops, which is what makes the settled number honest.
        if (value.reasoning !== lastReasoning) { lastReasoning = value.reasoning; thinkingMs = Date.now() - startedAtMs; }
        const next = { ...latest, ...value };
        latest = thinkingMs === undefined ? next : { ...next, thinkingMs };
        if (!timer) timer = setTimeout(flush, 50);
      } });
      return run.start();
    }).then((result) => {
      latest = { ...latest, status: result.status, error: result.error };
    }).catch(() => {
      latest = { ...latest, status: 'error', error: '模型组件加载失败，请刷新后重试。' };
    }).finally(() => {
      flush();
      if (latest.status === 'error') setError(latest.error ?? '模型回复失败，请稍后重试。');
      if (active.current === marker) { active.current = null; setRunningId(null); setStartedAt(null); }
    });
    return true;
  }

  return {
    runningId, startedAt, error, clearError: () => setError(null),
    stop: () => active.current?.abort(),
    send(content: string, existingId: string | null, thinkingEffort: ThinkingEffort = 'default', images: MessageImage[] = []) {
      const conversationId = existingId ?? createId();
      const current = conversations.find((item) => item.id === conversationId);
      const message: Message = { id: createId(), role: 'user', content, ...(images.length ? { images } : {}) };
      // start schedules work on a microtask; dispatch user before any reply update.
      if (!start(conversationId, [...(current?.messages ?? []), message], createId(), thinkingEffort)) return false;
      dispatch({ type: 'send', conversationId, message, thinkingEffort });
      return true;
    },
    retry(conversationId: string, thinkingEffort?: ThinkingEffort) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const last = conversation?.messages.at(-1);
      if (!conversation || !last || (last.role === 'assistant' && last.status !== 'error' && last.status !== 'stopped')) return;
      const history = last.role === 'assistant' ? conversation.messages.slice(0, -1) : conversation.messages;
      if (history.at(-1)?.role !== 'user') return;
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
