import type { ModelConfig } from '@/core/llm/model-config';
import { validateAgentRequest } from './context';
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt';
import type { ThinkingEffort } from './thinking-effort';
import type { Message, RuntimeSnapshot } from './types';
import type { createReplyRun } from './runner';

export type AgentRequest = {
  conversationId: string;
  replyId: string;
  messages: Message[];
  config?: ModelConfig;
  apiKey: string;
  thinkingEffort?: ThinkingEffort;
  systemPrompt?: string;
};

type RuntimeOptions = {
  onReply: (conversationId: string, message: Message) => void;
  /** The default lazily loads pi-agent. Other clients/tests can supply a compatible runner. */
  loadRunner?: () => Promise<{ createReplyRun: typeof createReplyRun }>;
};

/** Platform-independent runtime: one active request per workspace, no React, storage or DOM. */
export function createAgentRuntime({ onReply, loadRunner = () => import('./runner') }: RuntimeOptions) {
  let snapshot: RuntimeSnapshot = { runningId: null, startedAt: null, error: null };
  const listeners = new Set<() => void>();
  let active: { conversationId: string; abort: () => void } | null = null;
  let disposed = false;

  function update(patch: Partial<RuntimeSnapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clearError() { update({ error: null }); },
    stop() { active?.abort(); },
    dispose() {
      disposed = true;
      active?.abort();
      active = null;
      snapshot = { runningId: null, startedAt: null, error: null };
      listeners.clear();
    },
    start({ conversationId, replyId, messages, config, apiKey, thinkingEffort = 'default', systemPrompt = DEFAULT_SYSTEM_PROMPT }: AgentRequest): boolean {
      if (disposed || active) return false;
      const error = config ? validateAgentRequest(config, apiKey, messages, systemPrompt) : '请先在设置 → 模型服务中添加并选择模型。';
      if (error || !config) { update({ error }); return false; }
      // Freeze the request so subsequent UI/model edits apply to the next run only.
      const requestConfig = { ...config };
      const history = messages.map((message) => ({ ...message, ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}) }));
      const startedAt = Date.now();
      let latest: Message = { id: replyId, role: 'assistant', content: '', status: 'streaming' };
      let run: ReturnType<typeof createReplyRun> | undefined;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastReasoning = '';
      let thinkingMs: number | undefined;
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (!disposed) onReply(conversationId, { ...latest });
      };
      const marker = { conversationId, abort() { cancelled = true; run?.abort(); } };
      active = marker;
      update({ runningId: conversationId, startedAt, error: null });

      // Defer all runner work until the caller has recorded the outgoing user message.
      void Promise.resolve().then(loadRunner).then(async ({ createReplyRun }) => {
        if (cancelled) return { status: 'stopped' as const };
        run = createReplyRun({ config: requestConfig, apiKey, messages: history, thinkingEffort, systemPrompt, onUpdate(value) {
          if (disposed || cancelled) return;
          if (value.reasoning !== lastReasoning) { lastReasoning = value.reasoning; thinkingMs = Date.now() - startedAt; }
          const next = { ...latest, ...value };
          latest = thinkingMs === undefined ? next : { ...next, thinkingMs };
          if (!timer) timer = setTimeout(flush, 50);
        } });
        return run.start();
      }).then((result) => {
        latest = { ...latest, status: cancelled ? 'stopped' : result.status, error: cancelled ? undefined : result.error };
      }).catch(() => {
        latest = { ...latest, status: cancelled ? 'stopped' : 'error', error: cancelled ? undefined : '模型组件加载失败，请稍后重试。' };
      }).finally(() => {
        flush();
        if (active === marker) {
          active = null;
          update({ runningId: null, startedAt: null, ...(latest.status === 'error' ? { error: latest.error ?? '模型回复失败，请稍后重试。' } : {}) });
        }
      });
      return true;
    },
  };
}
