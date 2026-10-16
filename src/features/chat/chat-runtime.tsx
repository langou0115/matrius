import { createContext, useContext, useEffect, useRef, useState, type PropsWithChildren } from 'react';

import type { createReplyRun } from '@/core/agent/runner';
import { useModels } from '@/features/models/model-state';
import { useChat, type Message } from './chat-state';

function createId() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }

function useRuntime() {
  const { conversations, dispatch } = useChat();
  const models = useModels();
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<{ conversationId: string; abort: () => void } | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, []);
  useEffect(() => {
    if (active.current && !conversations.some((item) => item.id === active.current?.conversationId)) active.current.abort();
  }, [conversations]);

  function start(conversationId: string, history: Message[], replyId: string) {
    const config = models.selected;
    if (!config || !models.ready) { setError('请先在设置 → 模型服务中添加并选择模型。'); return false; }
    if (active.current) return false;
    if (config.requiresApiKey && !models.getKey(config.providerId)) { setError('请在模型服务中填写当前服务商的 API key。刷新后需要重新填写。'); return false; }
    // Conservative character estimate, leaving room for the output and system prompt.
    if (history.reduce((sum, item) => sum + item.content.length + 32, 0) > config.contextWindow - config.maxOutput - 256) {
      setError('对话可能超出上下文窗口，请新建对话或在模型设置中调整窗口。'); return false;
    }
    const apiKey = config.requiresApiKey ? models.getKey(config.providerId) : '';
    setError(null);
    setRunningId(conversationId);
    let latest: Message = { id: replyId, role: 'assistant', content: '', status: 'streaming' };
    let run: ReturnType<typeof createReplyRun> | undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { if (timer) clearTimeout(timer); timer = undefined; dispatch({ type: 'reply', conversationId, message: latest }); };
    const marker = { conversationId, abort() { cancelled = true; run?.abort(); } };
    active.current = marker;
    // Lazy import keeps provider SDKs out of the initial UI render.
    void import('@/core/agent/runner').then(async ({ createReplyRun }) => {
      if (cancelled) return { status: 'stopped' as const };
      run = createReplyRun({ config, apiKey, messages: history, onUpdate(value) {
        latest = { ...latest, ...value };
        if (!timer) timer = setTimeout(flush, 50);
      } });
      return run.start();
    }).then((result) => {
      latest = { ...latest, status: result.status, error: result.error };
    }).catch(() => {
      latest = { ...latest, status: 'error', error: '模型组件加载失败，请刷新后重试。' };
    }).finally(() => {
      flush();
      if (active.current === marker) { active.current = null; setRunningId(null); }
    });
    return true;
  }

  return {
    runningId, error, clearError: () => setError(null),
    stop: () => active.current?.abort(),
    send(content: string, existingId: string | null) {
      const conversationId = existingId ?? createId();
      const current = conversations.find((item) => item.id === conversationId);
      const message: Message = { id: createId(), role: 'user', content };
      // start schedules work on a microtask; dispatch user before any reply update.
      if (!start(conversationId, [...(current?.messages ?? []), message], createId())) return false;
      dispatch({ type: 'send', conversationId, message });
      return true;
    },
    retry(conversationId: string) {
      const conversation = conversations.find((item) => item.id === conversationId);
      const last = conversation?.messages.at(-1);
      if (!conversation || !last || (last.role === 'assistant' && last.status !== 'error' && last.status !== 'stopped')) return;
      const history = last.role === 'assistant' ? conversation.messages.slice(0, -1) : conversation.messages;
      if (history.at(-1)?.role !== 'user') return;
      start(conversationId, history, last.role === 'assistant' ? last.id : createId());
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
