import type { AgentTool } from '@mariozechner/pi-agent-core';

import type { ModelConfig } from '@/core/llm/model-config';
import { validateAgentRequest, validateContextSize } from './context';
import type { ConversationSummary } from './compaction';
import { DEFAULT_SYSTEM_PROMPT, withCurrentContext } from './system-prompt';
import type { ThinkingEffort } from './thinking-effort';
import type {
  AgentToolset, Message, ProcessActivity, ReplyRunner, ReplyUpdate, RunnerOptions,
  RuntimeSnapshot, SteerOutcome, TokenUsage, WebActivity,
} from './types';

export type AgentRequest = {
  conversationId: string;
  replyId: string;
  messages: Message[];
  config?: ModelConfig;
  apiKey: string;
  thinkingEffort?: ThinkingEffort;
  systemPrompt?: string;
  /** Rolling summary persisted with the conversation; empty means no earlier history is summarized. */
  contextSummary?: ConversationSummary;
  /** Server tools this run may use. The browser sends intent, not tool code. */
  toolset?: AgentToolset;
  /** Legacy in-process tools. Only injected runners (tests) consume these. */
  tools?: AgentTool[];
};

/** Stopping a run is a neutral cancellation, separate from a failed tool call. */
function settleActivities(activities: WebActivity[] | undefined, stopped = false): WebActivity[] | undefined {
  if (!activities?.some((activity) => activity.status === 'running')) return activities;
  return activities.map((activity) => activity.status === 'running'
    ? { ...activity, status: stopped ? 'stopped' as const : 'error' as const,
      error: stopped ? undefined : activity.error ?? '本次操作未完成。', endedAt: Date.now() }
    : activity);
}

function settleProcess(process: ProcessActivity[] | undefined, stopped: boolean): ProcessActivity[] | undefined {
  return process?.map((activity) => activity.status === 'running'
    ? { ...activity, status: stopped ? 'stopped' : 'error', endedAt: Date.now() } : activity);
}

type RunnerModule = { createReplyRun: (options: RunnerOptions) => ReplyRunner };

type RuntimeOptions = {
  onReply: (conversationId: string, message: Message) => void;
  /** Persists the rolling summary, or clears it when compaction no longer applies. */
  onSummary?: (conversationId: string, summary: ConversationSummary | undefined) => void;
  /** Tokens billed for one finished run, including stopped and failed replies. */
  onUsage?: (usage: TokenUsage) => void;
  /** A supplement that arrived after the visible answer started; it belongs to the next turn. */
  onDeferredMessage?: (conversationId: string, message: Message) => void;
  /** Runs the loop in the agent service instead of this process. Production uses this. */
  delegateToServer?: boolean;
  /** The default lazily loads the agent-service client. */
  loadRunner?: () => Promise<RunnerModule>;
  /** Optional local compaction adapter for isolated tests; production delegates to Node. */
  loadCompactor?: () => Promise<{ prepareHistory: typeof import('./compaction').prepareHistory }>;
};

/** Platform-independent runtime: one active request per conversation, no React, storage or DOM. */
export function createAgentRuntime({
  onReply, onSummary, onUsage, onDeferredMessage,
  delegateToServer = true,
  loadRunner = () => import('./remote-run'),
  loadCompactor = async () => { throw new Error('Local compaction requires an injected test adapter.'); },
}: RuntimeOptions) {
  let snapshot: RuntimeSnapshot = { runs: {}, error: null };
  const listeners = new Set<() => void>();
  // Keyed by conversation: separate chats run concurrently, while a chat cannot start twice.
  type ActiveRun = { abort: () => void; steer: (message: Message) => SteerOutcome };
  const active = new Map<string, ActiveRun>();
  // Latest streamed reply per conversation: the service enforces the same rule, but callers
  // need a synchronous answer about whether a supplement can still join the current run.
  const latestByConversation = new Map<string, Message>();
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
    /** Without an id, cancels every run (used when the workspace is torn down). */
    stop(conversationId?: string) {
      if (conversationId === undefined) { active.forEach((marker) => marker.abort()); return; }
      active.get(conversationId)?.abort();
    },
    /** Queue a supplement into the active run. False means the caller should send normally. */
    steer(conversationId: string, message: Message): SteerOutcome {
      if (disposed) return false;
      return active.get(conversationId)?.steer(message) ?? false;
    },
    dispose() {
      disposed = true;
      active.forEach((marker) => marker.abort());
      active.clear();
      snapshot = { runs: {}, error: null };
      listeners.clear();
    },
    start({ conversationId, replyId, messages, config, apiKey, thinkingEffort = 'default', systemPrompt = withCurrentContext(DEFAULT_SYSTEM_PROMPT), contextSummary, toolset, tools }: AgentRequest): boolean {
      if (disposed || active.has(conversationId)) return false;
      // The size check runs after silent compaction, so an over-window history can still be
      // reduced instead of failing before the request starts.
      const error = config ? validateAgentRequest(config, apiKey, messages, systemPrompt, false) : '请先在设置 → 模型服务中添加并选择模型。';
      if (error || !config) { update({ error }); return false; }
      // Freeze the request so subsequent UI/model edits apply to the next run only.
      const requestConfig = { ...config };
      const history = messages.map((message) => ({ ...message, ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}) }));
      const startedAt = Date.now();
      let latest: Message = { id: replyId, role: 'assistant', content: '', status: 'streaming' };
      let run: ReplyRunner | undefined;
      let cancelled = false;
      // A silent compaction request belongs to this run: stopping the reply also stops the
      // auxiliary model call instead of letting it finish in the background.
      const runAbort = new AbortController();
      // Steering can arrive before the lazy-loaded runner exists; queue it against the run.
      let pendingSteers: Message[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = undefined;
        if (!disposed) onReply(conversationId, { ...latest });
      };
      const marker: ActiveRun = {
        abort() { cancelled = true; pendingSteers = []; runAbort.abort(); run?.abort(); },
        steer(message: Message): SteerOutcome {
          if (cancelled) return false;
          if (!run) { pendingSteers.push(message); return 'steered'; }
          if (delegateToServer && latestByConversation.get(conversationId)?.content.trim()) return 'deferred';
          return run.steer(message);
        },
      };
      active.set(conversationId, marker);
      update({ runs: { ...snapshot.runs, [conversationId]: { conversationId, replyId, startedAt } }, error: null });

      // Defer all runner work until the caller has recorded the outgoing user message.
      void Promise.all([
        loadRunner(),
        delegateToServer ? Promise.resolve(null) : loadCompactor(),
      ]).then(async ([{ createReplyRun }, compactor]) => {
        if (cancelled) return { status: 'stopped' as const };
        let preparedMessages = history;
        let preparedSystemPrompt = systemPrompt;
        let preparedSummary = contextSummary;
        if (compactor) {
          const prepared = await compactor.prepareHistory({
            messages: history, config: requestConfig, apiKey, systemPrompt,
            ...(contextSummary ? { previous: contextSummary } : {}),
            signal: runAbort.signal,
          });
          if (cancelled) return { status: 'stopped' as const };
          // Persist the coverage marker with the conversation so a reload resumes from the same
          // point. `undefined` clears a summary that no longer matches the stored history.
          if (onSummary && JSON.stringify(prepared.summary) !== JSON.stringify(contextSummary)) {
            onSummary(conversationId, prepared.summary);
          }
          const overflow = validateContextSize(requestConfig, prepared.messages, prepared.systemPrompt);
          if (overflow) return { status: 'error' as const, error: overflow };
          preparedMessages = prepared.messages;
          preparedSystemPrompt = prepared.systemPrompt;
          preparedSummary = prepared.summary;
        }
        run = createReplyRun({
          conversationId, replyId, config: requestConfig, apiKey,
          messages: preparedMessages, thinkingEffort, systemPrompt: preparedSystemPrompt,
          ...(preparedSummary ? { contextSummary: preparedSummary } : {}),
          ...(toolset ? { toolset } : {}),
          ...(delegateToServer ? {
            onSummary: (summary: ConversationSummary | undefined) => onSummary?.(conversationId, summary),
            onDeferred: (message: Message) => onDeferredMessage?.(conversationId, message),
          } : {}),
          ...(tools?.length ? { tools } : {}),
          onUpdate(value: ReplyUpdate) {
            if (disposed || cancelled) return;
            const { contextTokens, ...reply } = value;
            if (contextTokens && snapshot.contexts?.[conversationId] !== contextTokens) {
              update({ contexts: { ...snapshot.contexts, [conversationId]: contextTokens } });
            }
            latest = { ...latest, ...reply, thinkingMs: Math.max(0, Date.now() - startedAt) };
            latestByConversation.set(conversationId, latest);
            if (!timer) timer = setTimeout(flush, 50);
          },
        } as RunnerOptions);
        // Injected before `start()`, so pi-agent sees them before the first model call.
        for (const message of pendingSteers) run.steer(message);
        pendingSteers = [];
        return run.start();
      }).then((result) => {
        // The workspace may have been torn down by a logout or instance switch while the
        // provider was still answering; never bill that run to the next instance.
        if (result.usage && !disposed) onUsage?.(result.usage);
        const activities = settleActivities(latest.activities, cancelled || result.status === 'stopped');
        latest = {
          ...latest,
          status: cancelled ? 'stopped' : result.status,
          error: cancelled ? undefined : result.error,
          ...(activities ? { activities } : {}),
          ...(latest.process ? { process: settleProcess(latest.process, cancelled || result.status === 'stopped') } : {}),
        };
      }).catch(() => {
        const activities = settleActivities(latest.activities, cancelled);
        latest = {
          ...latest,
          status: cancelled ? 'stopped' : 'error',
          error: cancelled ? undefined : run ? '回复中断，已生成内容已保留。' : '模型组件加载失败，请稍后重试。',
          ...(activities ? { activities } : {}),
          ...(latest.process ? { process: settleProcess(latest.process, cancelled) } : {}),
        };
      }).finally(() => {
        latest = { ...latest, reasoningActive: false, thinkingMs: Math.max(0, Date.now() - startedAt) };
        flush();
        // A concurrent run in another conversation must not clear this one's marker.
        if (active.get(conversationId) === marker) {
          active.delete(conversationId);
          latestByConversation.delete(conversationId);
          const runs = { ...snapshot.runs };
          delete runs[conversationId];
          // Failures stay on the reply message: a workspace-wide error would surface in
          // whichever conversation happens to be open, not the one that failed.
          update({ runs });
        }
      });
      return true;
    },
  };
}
