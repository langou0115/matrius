import { CONTEXT_SAFETY_TOKENS, estimateMessageTokens, estimateTextTokens } from '@/core/agent/context';
import { withoutFailedReplies } from '@/core/agent/history';
import type { ModelConfig } from '@/core/llm/model-config';
import type { Message } from '@/core/agent/types';
import type { ReplyUpdate } from '@/core/agent/types';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { appendConversationSummary, type ConversationSummary } from '@/core/agent/compaction';
import type { MemoryPreferences } from '@/core/agent/memory';
import { memoryPromptBlock } from '@/core/agent/memory';

/** One call's prompt-side split plus its output, or an estimate of the next request. */
export type ContextUsage = {
  /** Prompt tokens that were not served from cache (including tokens written to it). */
  uncachedInput: number;
  /** Prompt tokens read from the provider cache. */
  cachedInput: number;
  /** Tokens produced by the latest call. */
  output: number;
  /** Occupancy of one call, never the sum of multiple billed calls. */
  total: number;
  /** The selected model's full context window. */
  window: number;
  /** Input budget after reserving the output allowance and compaction safety margin. */
  limit: number;
  /** Total as a percentage of the full window, rounded and capped at 100. */
  percent: number;
};

/**
 * Live readings come from the latest individual model call, split into uncached input, cached
 * input and output. Before a call (including after reload), estimate retained text, summary and
 * tool definitions as uncached input; never substitute daily usage.
 */
export function measureContextUsage(
  messages: Message[],
  systemPrompt: string,
  config: Pick<ModelConfig, 'contextWindow' | 'maxOutput'>,
  options: { tools?: AgentTool[]; summary?: ConversationSummary; memory?: MemoryPreferences; latestCall?: ReplyUpdate['contextTokens'] } = {},
): ContextUsage {
  const covered = options.summary ? messages.findIndex((message) => message.id === options.summary!.coveredUntilMessageId) : -1;
  if (covered >= 0) {
    messages = messages.slice(covered + 1);
    systemPrompt = appendConversationSummary(systemPrompt, options.summary!.summary);
  }
  let estimatedInput = estimateTextTokens(systemPrompt);
  if (options.tools?.length) {
    estimatedInput += estimateTextTokens(JSON.stringify(options.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))));
  }
  for (const message of withoutFailedReplies(messages)) estimatedInput += estimateMessageTokens(message);
  if (options.memory) estimatedInput += estimateTextTokens(memoryPromptBlock(options.memory));

  let uncachedInput = estimatedInput;
  let cachedInput = 0;
  let output = 0;
  if (options.latestCall) {
    const input = Math.max(0, options.latestCall.input);
    cachedInput = Math.min(input, Math.max(0, options.latestCall.cacheRead ?? 0));
    uncachedInput = Math.max(0, input - cachedInput);
    output = Math.max(0, options.latestCall.output);
  }
  const total = uncachedInput + cachedInput + output;
  const window = Math.max(1, config.contextWindow);
  const reservedOutput = Math.min(config.maxOutput, Math.floor(window * 0.5));
  const limit = Math.max(1, window - reservedOutput - CONTEXT_SAFETY_TOKENS);
  return {
    uncachedInput,
    cachedInput,
    output,
    total,
    window,
    limit,
    percent: Math.min(100, Math.round((total / window) * 100)),
  };
}
