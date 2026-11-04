import type { ThinkingBudgets } from '@mariozechner/pi-ai';

/** Keep at least this much of a reply for visible text and tool-call arguments. */
export const MIN_VISIBLE_OUTPUT_TOKENS = 4096;
/** Long reasoning rarely improves layout-heavy document work, and can crowd out the writing. */
export const MAX_THINKING_BUDGET_TOKENS = 8192;
const MIN_THINKING_BUDGET_TOKENS = 512;

/**
 * pi-ai keeps thinking inside the same max_tokens window as the answer, and token-based
 * providers shrink the thinking budget when it would not fit. With `maxTokens` equal to a
 * small `maxOutput`, "medium"/"high" could leave as little as 1024 tokens for the visible
 * answer, so a document request ran out of budget before writing anything.
 *
 * These budgets reserve a visible-output floor and cap the thinking ceiling; the stream
 * function still never requests more than the model's configured output limit.
 */
export function thinkingBudgetsFor(maxOutput: number): ThinkingBudgets {
  const available = Math.max(0, Math.floor(maxOutput) - MIN_VISIBLE_OUTPUT_TOKENS);
  const high = Math.max(MIN_THINKING_BUDGET_TOKENS, Math.min(MAX_THINKING_BUDGET_TOKENS, available));
  return {
    minimal: Math.min(high, 512),
    low: Math.min(high, 2048),
    medium: Math.min(high, 4096),
    high,
  };
}

/** How many tokens the current level may spend on thinking before the answer starts. */
export function thinkingBudgetFor(maxOutput: number, level: keyof ThinkingBudgets): number {
  return thinkingBudgetsFor(maxOutput)[level] ?? MIN_THINKING_BUDGET_TOKENS;
}
