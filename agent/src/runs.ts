import { prepareHistory, type ConversationSummary } from '@/core/agent/compaction';
import { validateContextSize } from '@/core/agent/context';
import { createReplyRun } from '@/core/agent/runner';
import type { Message, ReplyResult, ReplyUpdate, SteerOutcome } from '@/core/agent/types';
import type { ThinkingEffort } from '@/core/agent/thinking-effort';
import type { ModelConfig } from '@/core/llm/model-config';

import { buildTools, type Toolset } from './tools';

export type RunRequest = {
  conversationId: string;
  replyId: string;
  messages: Message[];
  config: ModelConfig;
  apiKey?: string;
  thinkingEffort?: ThinkingEffort;
  /** Assembled by the client from personalization, memory and the shared default prompt. */
  systemPrompt: string;
  contextSummary?: ConversationSummary;
  toolset?: Toolset;
};

export type Emit = (event: 'ready' | 'update' | 'summary' | 'done', data: unknown) => void;

type ActiveRun = {
  abort(): void;
  steer(message: Message): SteerOutcome;
};

/** One conversation can have at most one run; separate conversations run in parallel. */
const active = new Map<string, ActiveRun>();

export function stopRun(conversationId: string): boolean {
  const run = active.get(conversationId);
  if (!run) return false;
  run.abort();
  return true;
}

export function steerRun(conversationId: string, message: Message): SteerOutcome {
  return active.get(conversationId)?.steer(message) ?? false;
}

/**
 * Runs one reply: silent compaction, then the pi-agent loop, streaming the same
 * `ReplyUpdate` payload the browser used to build locally.
 */
export async function executeRun(request: RunRequest, emit: Emit): Promise<void> {
  const { conversationId } = request;
  const { tools, prompts } = buildTools(request.toolset, conversationId);
  const systemPrompt = [request.systemPrompt, ...prompts].filter(Boolean).join('\n\n');
  const controller = new AbortController();
  const queued: Message[] = [];
  let reply: ReturnType<typeof createReplyRun> | undefined;

  const marker: ActiveRun = {
    abort() {
      controller.abort();
      reply?.abort();
    },
    steer(message: Message): SteerOutcome {
      if (!reply) {
        queued.push(message);
        return 'steered';
      }
      return reply.steer(message);
    },
  };
  active.set(conversationId, marker);

  // Coalesce model deltas: the transport should carry at most ~20 frames per second.
  let latest: ReplyUpdate | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (!latest) return;
    emit('update', latest);
    latest = null;
  };

  try {
    emit('ready', { conversationId });
    const prepared = await prepareHistory({
      messages: request.messages,
      config: request.config,
      apiKey: request.apiKey ?? '',
      systemPrompt,
      ...(request.contextSummary ? { previous: request.contextSummary } : {}),
      signal: controller.signal,
    });
    emit('summary', { summary: prepared.summary ?? null });
    const overflow = validateContextSize(request.config, prepared.messages, prepared.systemPrompt);
    if (overflow) {
      emit('done', { status: 'error', error: overflow } satisfies ReplyResult);
      return;
    }
    if (controller.signal.aborted) {
      emit('done', { status: 'stopped' } satisfies ReplyResult);
      return;
    }

    reply = createReplyRun({
      config: request.config,
      apiKey: request.apiKey ?? '',
      messages: prepared.messages,
      thinkingEffort: request.thinkingEffort,
      systemPrompt: prepared.systemPrompt,
      ...(tools.length ? { tools } : {}),
      signal: controller.signal,
      onUpdate(value) {
        latest = value;
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          flush();
        }, 50);
      },
    });
    // Steering that arrived while compaction was still running applies before the first call.
    for (const message of queued.splice(0)) reply.steer(message);
    const result = await reply.start();
    flush();
    emit('done', result);
  } catch (error) {
    flush();
    emit('done', {
      status: controller.signal.aborted ? 'stopped' : 'error',
      error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : 'Agent 运行失败。',
    } satisfies ReplyResult);
  } finally {
    if (timer) clearTimeout(timer);
    if (active.get(conversationId) === marker) active.delete(conversationId);
  }
}
