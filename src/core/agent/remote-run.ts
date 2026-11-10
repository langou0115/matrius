import type { ConversationSummary } from './compaction';
import type { Message, ReplyResult, ReplyRunner, ReplyUpdate, RunnerOptions, SteerOutcome } from './types';

/**
 * Client for the agent service. It implements the same contract as the in-browser runner,
 * so the runtime and chat adapter above it do not know where the model loop runs.
 *
 * The service streams the exact `ReplyUpdate` payload the local runner produced, which keeps
 * message rendering, persistence and activity handling unchanged.
 */

const RUN_PATH = '/api/agent/run';
const STEER_PATH = '/api/agent/steer';
const STOP_PATH = '/api/agent/stop';

function parseEvent(chunk: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  return { event, data: data.join('\n') };
}

async function consume(body: ReadableStream<Uint8Array>, onEvent: (event: string, data: unknown) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const drain = () => {
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const parsed = parseEvent(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      if (parsed) {
        try {
          onEvent(parsed.event, JSON.parse(parsed.data) as unknown);
        } catch {
          // A truncated frame is ignored: the done frame carries the authoritative result.
        }
      }
      index = buffer.indexOf('\n\n');
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    drain();
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const parsed = parseEvent(buffer);
    if (parsed) {
      try { onEvent(parsed.event, JSON.parse(parsed.data) as unknown); } catch { /* ignored */ }
    }
  }
}

export function createReplyRun(options: RunnerOptions): ReplyRunner {
  const controller = new AbortController();
  let finished = false;

  const stop = () => {
    if (finished) return;
    finished = true;
    controller.abort();
    // The service owns the provider stream: closing the response alone may leave it running.
    void fetch(STOP_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: options.conversationId }),
      keepalive: true,
    }).catch(() => {});
  };
  options.signal?.addEventListener('abort', stop, { once: true });

  const body = () => JSON.stringify({
    conversationId: options.conversationId,
    replyId: options.replyId,
    messages: options.messages,
    config: options.config,
    apiKey: options.apiKey,
    ...(options.thinkingEffort ? { thinkingEffort: options.thinkingEffort } : {}),
    systemPrompt: options.systemPrompt ?? '',
    ...(options.contextSummary ? { contextSummary: options.contextSummary } : {}),
    ...(options.toolset ? { toolset: options.toolset } : {}),
  });

  return {
    abort: stop,
    /** Best-effort: the service answers whether the supplement was applied or deferred. */
    steer(message: Message): SteerOutcome {
      if (finished) return false;
      void fetch(STEER_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: options.conversationId, message }),
      }).then((response) => response.json() as Promise<{ outcome?: SteerOutcome }>)
        .then((payload) => {
          if (payload.outcome === 'deferred') options.onDeferred?.(message);
        })
        .catch(() => {
          options.onDeferred?.(message);
        });
      return 'steered';
    },
    async start(): Promise<ReplyResult> {
      if (options.signal?.aborted) return { status: 'stopped' };
      let response: Response;
      try {
        response = await fetch(RUN_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body(),
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch {
        finished = true;
        return controller.signal.aborted
          ? { status: 'stopped' }
          : { status: 'error', error: '无法连接 Agent 服务，请确认它已启动（npm run agent）。' };
      }
      if (!response.ok || !response.body) {
        finished = true;
        let message = 'Agent 服务返回错误。';
        try {
          const payload = await response.json() as { error?: { message?: string } };
          if (payload.error?.message) message = payload.error.message;
        } catch {
          // keep the generic message
        }
        return { status: 'error', error: message };
      }

      let result: ReplyResult | null = null;
      try {
        await consume(response.body, (event, data) => {
          if (event === 'update') options.onUpdate(data as ReplyUpdate);
          else if (event === 'summary') {
            const summary = (data as { summary?: ConversationSummary | null }).summary;
            options.onSummary?.(summary ?? undefined);
          } else if (event === 'done') result = data as ReplyResult;
        });
      } catch {
        if (!result) {
          return controller.signal.aborted
            ? { status: 'stopped' }
            : { status: 'error', error: 'Agent 连接中断，已生成的内容已保留。' };
        }
      } finally {
        finished = true;
      }
      return result ?? (controller.signal.aborted
        ? { status: 'stopped' }
        : { status: 'error', error: 'Agent 未返回结果，已生成的内容已保留。' });
    },
  };
}
