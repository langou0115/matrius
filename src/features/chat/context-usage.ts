import { CONTEXT_SAFETY_TOKENS, estimateMessageTokens, estimateTextTokens } from '@/core/agent/context';
import { withoutFailedReplies } from '@/core/agent/history';
import type { ModelConfig } from '@/core/llm/model-config';
import type { Message } from '@/core/agent/types';

/** Estimated tokens for the next request, split by what the model reads and writes. */
export type ContextUsage = {
  /** System prompt plus the user-side history. */
  input: number;
  /** Assistant replies already in the history. */
  output: number;
  /** Input plus output, i.e. the context carried into the next request. */
  total: number;
  /** The selected model's full context window. */
  window: number;
  /** Input budget after reserving the output allowance and compaction safety margin. */
  limit: number;
  /** Total as a percentage of the full window, rounded and capped at 100. */
  percent: number;
};

/**
 * The composer's meter is an estimate: provider tokenizers differ, and the next request may
 * still be compacted. It deliberately mirrors the estimator the runtime uses for its context
 * guard, so the percentage and the "conversation is too long" warning agree with each other.
 */
export function measureContextUsage(
  messages: Message[],
  systemPrompt: string,
  config: Pick<ModelConfig, 'contextWindow' | 'maxOutput'>,
): ContextUsage {
  let input = estimateTextTokens(systemPrompt);
  let output = 0;
  for (const message of withoutFailedReplies(messages)) {
    const tokens = estimateMessageTokens(message);
    if (message.role === 'user') input += tokens;
    else output += tokens;
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
