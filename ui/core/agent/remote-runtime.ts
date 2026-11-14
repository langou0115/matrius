import type {
  AgentRunEnd,
  AgentRunEvent,
  AgentRunRequest,
  ContextSummary,
  Message,
  TokenUsage,
} from '../../../contract/agent-protocol';
import type { AgentRequest } from './request';
import type { RuntimeSnapshot, RuntimeRun, SteerOutcome } from './types';

type RuntimeOptions = {
  onReply: (conversationId: string, message: Message) => void;
  onSummary?: (conversationId: string, summary: ContextSummary | undefined) => void;
  onUsage?: (usage: TokenUsage) => void;
};

type ActiveRun = {
  conversationId: string;
  replyId: string;
  startedAt: number;
  controller: AbortController;
  latest: Message;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  cancelled: boolean;
};

function errorMessage(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const error = (payload as Record<string, unknown>).error;
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
      return String((error as Record<string, unknown>).message);
    }
    if (typeof error === 'string') return error;
  }
  return '无法启动回复。';
}

/** Read the server's `event:`/`data:` frames without buffering the whole stream. */
async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: AgentRunEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parseBlock = (block: string) => {
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    try {
      onEvent(JSON.parse(data) as AgentRunEvent);
    } catch {
      // A malformed frame must not tear down an otherwise healthy stream.
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      parseBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) parseBlock(buffer);
}

/**
 * Browser side of the remote Agent: one POST per run, SSE updates, HTTP steer/stop.
 * The server owns model calls, context assembly, compaction and tools.
 */
export function createRemoteAgentRuntime({ onReply, onSummary, onUsage }: RuntimeOptions) {
  let snapshot: RuntimeSnapshot = { runs: {}, error: null };
  const listeners = new Set<() => void>();
  const active = new Map<string, ActiveRun>();
  let disposed = false;

  function update(patch: Partial<RuntimeSnapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }

  function flush(entry: ActiveRun) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (disposed) return;
    onReply(entry.conversationId, {
      ...entry.latest,
      thinkingMs: Math.max(0, Date.now() - entry.startedAt),
    });
  }

  function schedule(entry: ActiveRun) {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      flush(entry);
    }, 50);
  }

  function close(entry: ActiveRun) {
    if (entry.closed) return;
    entry.closed = true;
    flush(entry);
    if (active.get(entry.conversationId) === entry) {
      active.delete(entry.conversationId);
      const runs = { ...snapshot.runs };
      delete runs[entry.conversationId];
      update({ runs });
    }
  }

  function end(entry: ActiveRun, result: AgentRunEnd) {
    entry.latest = {
      ...entry.latest,
      status: entry.cancelled ? 'stopped' : result.status,
      ...(entry.cancelled || !result.error ? {} : { error: result.error }),
      reasoningActive: false,
      process: entry.latest.process?.map((activity) => activity.status === 'running'
        ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
        : activity),
      activities: entry.latest.activities?.map((activity) => activity.status === 'running'
        ? { ...activity, status: entry.cancelled ? 'stopped' as const : 'error' as const, endedAt: Date.now() }
        : activity),
    };
    if (result.usage && !disposed) onUsage?.(result.usage);
    close(entry);
  }

  async function stream(entry: ActiveRun, request: AgentRequest) {
    const body: AgentRunRequest = {
      conversationId: request.conversationId,
      replyId: request.replyId,
      model: request.config as AgentRunRequest['model'],
      messages: request.messages,
      ...(request.apiKey ? { apiKey: request.apiKey } : {}),
      ...(request.thinkingEffort ? { thinkingEffort: request.thinkingEffort } : {}),
      ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
      ...(request.memoryText ? { memoryText: request.memoryText } : {}),
      ...(request.contextSummary ? { contextSummary: request.contextSummary } : {}),
      ...(request.enabledTools ? { tools: request.enabledTools } : {}),
    };
    try {
      const response = await fetch('/api/agent/runs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: entry.controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        entry.latest = {
          ...entry.latest,
          status: 'error',
          error: errorMessage(payload),
          reasoningActive: false,
        };
        close(entry);
        return;
      }
      if (!response.body) throw new Error('服务端没有返回事件流。');

      let ended = false;
      await readEvents(response.body, (event) => {
        if (disposed) return;
        if (event.type === 'update') {
          const updateValue = event.update;
          if (updateValue.contextTokens) {
            update({
              contexts: {
                ...snapshot.contexts,
                [entry.conversationId]: updateValue.contextTokens,
              },
            });
          }
          const { contextTokens: _contextTokens, ...reply } = updateValue;
          entry.latest = { ...entry.latest, ...reply };
          schedule(entry);
          return;
        }
        if (event.type === 'summary') {
          onSummary?.(entry.conversationId, event.contextSummary);
          return;
        }
        if (event.type === 'end') {
          ended = true;
          end(entry, event.result);
        }
      });
      if (!ended && !entry.closed) {
        entry.latest = {
          ...entry.latest,
          status: entry.cancelled ? 'stopped' : 'error',
          error: entry.cancelled ? undefined : '回复连接中断，已生成内容已保留。',
          reasoningActive: false,
        };
        close(entry);
      }
    } catch (error) {
      if (entry.closed) return;
      entry.latest = {
        ...entry.latest,
        status: entry.cancelled ? 'stopped' : 'error',
        error: entry.cancelled
          ? undefined
          : error instanceof Error && error.name !== 'AbortError'
            ? error.message
            : '回复连接中断，已生成内容已保留。',
        reasoningActive: false,
      };
      close(entry);
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clearError() { update({ error: null }); },
    stop(conversationId?: string) {
      const entries = conversationId === undefined
        ? [...active.values()]
        : [...active.values()].filter((entry) => entry.conversationId === conversationId);
      for (const entry of entries) {
        entry.cancelled = true;
        entry.controller.abort();
        entry.latest = { ...entry.latest, status: 'stopped', reasoningActive: false };
        close(entry);
        void fetch(`/api/agent/runs/${encodeURIComponent(entry.conversationId)}/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(() => {});
      }
    },
    steer(conversationId: string, message: Message): SteerOutcome {
      if (disposed || !active.has(conversationId)) return false;
      // Steering is asynchronous HTTP; the UI marks it steered immediately and the
      // authoritative turn is the one the server appends.
      void fetch(`/api/agent/runs/${encodeURIComponent(conversationId)}/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      }).catch(() => {});
      return 'steered';
    },
    dispose() {
      disposed = true;
      active.forEach((entry) => {
        entry.controller.abort();
        if (entry.timer) clearTimeout(entry.timer);
      });
      active.clear();
      snapshot = { runs: {}, error: null };
      listeners.clear();
    },
    start(request: AgentRequest): boolean {
      if (disposed || active.has(request.conversationId)) return false;
      if (!request.config) {
        update({ error: '请先在设置 → 模型服务中添加并选择模型。' });
        return false;
      }
      if (request.config.requiresApiKey && !request.apiKey) {
        update({ error: '请先填写模型 API Key。' });
        return false;
      }
      const startedAt = Date.now();
      const entry: ActiveRun = {
        conversationId: request.conversationId,
        replyId: request.replyId,
        startedAt,
        controller: new AbortController(),
        latest: { id: request.replyId, role: 'assistant', content: '', status: 'streaming' },
        closed: false,
        cancelled: false,
      };
      active.set(request.conversationId, entry);
      const run: RuntimeRun = {
        conversationId: request.conversationId,
        replyId: request.replyId,
        startedAt,
      };
      update({ runs: { ...snapshot.runs, [request.conversationId]: run }, error: null });
      void stream(entry, request);
      return true;
    },
  };
}
