import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_THINKING_BUDGET_TOKENS,
  MIN_VISIBLE_OUTPUT_TOKENS,
  thinkingBudgetFor,
  thinkingBudgetsFor,
} from '../agent/src/core/thinking-budget.ts';

test('thinking budgets always leave room for the visible answer', () => {
  for (const maxOutput of [4096, 8192, 16384, 32768, 200000]) {
    const budgets = thinkingBudgetsFor(maxOutput);
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      assert.ok(budgets[level] > 0, `${level} must stay positive`);
      assert.ok(budgets[level] <= MAX_THINKING_BUDGET_TOKENS);
      // The thinking budget is what the provider may spend before the answer starts, so
      // the reply window must keep at least the visible floor on top of it.
      const visible = Math.min(maxOutput - budgets[level], maxOutput);
      assert.ok(
        visible >= Math.min(MIN_VISIBLE_OUTPUT_TOKENS, Math.floor(maxOutput / 2)),
        `${maxOutput}/${level} left only ${visible} tokens for the answer`,
      );
    }
  }
});

test('a small output budget shrinks thinking instead of starving the answer', () => {
  // 4096 used to give "high" a 3072-token thinking budget, leaving ~1024 for the body.
  assert.equal(thinkingBudgetsFor(4096).high, 512);
  assert.equal(thinkingBudgetFor(4096, 'high'), 512);
  assert.equal(thinkingBudgetsFor(4096).low, 512);
});

test('a larger output budget rewards deeper thinking without exceeding the ceiling', () => {
  const budgets = thinkingBudgetsFor(16384);
  assert.equal(budgets.high, MAX_THINKING_BUDGET_TOKENS);
  assert.equal(budgets.medium, 4096);
  assert.equal(budgets.low, 2048);
  assert.equal(budgets.minimal, 512);
  assert.ok(budgets.high > budgets.medium, 'high must allow more thinking than medium');
});
