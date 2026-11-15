import { CONTEXT_SAFETY_TOKENS, estimateMessageTokens, estimateTextTokens, withoutFailedReplies } from '@contract/agent-context';
import { appendConversationSummary, type ConversationSummary } from '@contract/agent-compaction';
import { memoryPromptBlock, type MemoryPreferences } from '@contract/agent-memory';
import type { ModelConfig } from '@contract/agent-provider';
import type { Message, ReplyUpdate } from '@contract/agent-types';
import type { AgentTool } from '@mariozechner/pi-agent-core';

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
 * Live readings come from the latest provider-reported call, split into uncached input, cached
 * input and output. The reading is held across call boundaries, so starting the next request
 * never turns it into a zero-output estimate; only a conversation with no report yet (a new
 * chat or a reload) is estimated from retained text, summary, memory and tool definitions.
 * Never substitute daily usage.
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
