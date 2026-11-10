import { CONTEXT_SAFETY_TOKENS, estimateMessageTokens, estimateTextTokens } from '@agent/core/context';
import { withoutFailedReplies } from '@agent/core/history';
import type { ModelConfig } from '@/core/llm/model-config';
import type { Message } from '@agent/core/types';
import type { ReplyUpdate } from '@agent/core/types';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { appendConversationSummary, type ConversationSummary } from '@agent/core/conversation-summary';

/** Latest call occupancy, or an estimate of the next request when no call is available. */
export type ContextUsage = {
  /** Latest call input including cache, or estimated system/tools/user history. */
  input: number;
  /** Latest call output, or assistant text in the estimated next request. */
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
 * Live readings come from the latest individual model call. Before a call (including after
 * reload), estimate retained text, summary and tool definitions; never substitute daily usage.
 */
export function measureContextUsage(
  messages: Message[],
  systemPrompt: string,
  config: Pick<ModelConfig, 'contextWindow' | 'maxOutput'>,
  options: { tools?: AgentTool[]; summary?: ConversationSummary; latestCall?: ReplyUpdate['contextTokens'] } = {},
): ContextUsage {
  const covered = options.summary ? messages.findIndex((message) => message.id === options.summary!.coveredUntilMessageId) : -1;
  if (covered >= 0) {
    messages = messages.slice(covered + 1);
    systemPrompt = appendConversationSummary(systemPrompt, options.summary!.summary);
  }
  let input = estimateTextTokens(systemPrompt);
  if (options.tools?.length) input += estimateTextTokens(JSON.stringify(options.tools.map(({ name, description, parameters }) => ({ name, description, parameters }))));
  let output = 0;
  for (const message of withoutFailedReplies(messages)) {
    const tokens = estimateMessageTokens(message);
    if (message.role === 'user') input += tokens;
    else output += tokens;
  }
  if (options.latestCall) {
    input = options.latestCall.input;
    output = options.latestCall.output;
  }
  const total = input + output;
  const window = Math.max(1, config.contextWindow);
  const reservedOutput = Math.min(config.maxOutput, Math.floor(window * 0.5));
  const limit = Math.max(1, window - reservedOutput - CONTEXT_SAFETY_TOKENS);
  return {
    input,
    output,
    total,
    window,
    limit,
    percent: Math.min(100, Math.round((total / window) * 100)),
  };
}
