import assert from 'node:assert/strict';
import { test } from 'node:test';

import { measureContextUsage } from '../ui/features/chat/context-usage.ts';

test('context usage estimates the next request as uncached input', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'a'.repeat(400) },
    { id: 'a1', role: 'assistant', content: 'a'.repeat(200) },
    { id: 'u2', role: 'user', content: '你好' },
  ];
  const usage = measureContextUsage(messages, 'system', { contextWindow: 10_000, maxOutput: 1_000 });

  // system 2; user (8 + 100) + assistant (8 + 50) + user (8 + 3).
  assert.equal(usage.uncachedInput, 179);
  assert.equal(usage.cachedInput, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.total, 179);
  assert.equal(usage.window, 10_000);
  assert.equal(usage.limit, 10_000 - 1_000 - 2_048);
  assert.equal(usage.percent, 2);
});

test('context usage caps the percentage and flags a conversation over the input budget', () => {
  const usage = measureContextUsage(
    [{ id: 'u1', role: 'user', content: 'a'.repeat(80_000) }],
    '',
    { contextWindow: 10_000, maxOutput: 1_000 },
  );

  assert.equal(usage.percent, 100);
  assert.ok(usage.total > usage.limit);
  assert.ok(usage.total > usage.window);
});

test('tool definitions count toward context and covered history is replaced by its summary', () => {
  const config = { contextWindow: 128000, maxOutput: 4096 };
  const messages = [{ id: 'old', role: 'user', content: 'x'.repeat(4000) }, { id: 'new', role: 'user', content: 'hello' }];
  const plain = measureContextUsage(messages, '', config);
  const withTools = measureContextUsage(messages, '', config, {
    tools: [{ name: 'file', description: 'instructions'.repeat(1000), parameters: { type: 'object' } }],
  });
  assert.ok(withTools.uncachedInput > plain.uncachedInput + 2000);
  const summarized = measureContextUsage(messages, '', config, { summary: { coveredUntilMessageId: 'old', summary: 'short' } });
  assert.ok(summarized.total < plain.total);
});

test('the latest call splits prompt tokens into uncached input and cached input', () => {
  const usage = measureContextUsage([], '', { contextWindow: 128000, maxOutput: 4096 }, {
    latestCall: {
      input: 80000, cacheRead: 30000, cacheWrite: 0,
      output: 4000, modelId: 'model', contextWindow: 128000,
    },
  });
  assert.equal(usage.uncachedInput, 50000);
  assert.equal(usage.cachedInput, 30000);
  assert.equal(usage.output, 4000);
  assert.equal(usage.total, 84000);
  assert.equal(usage.percent, 66);
});

test('cache writes stay in uncached input instead of counting as cache reads', () => {
  const usage = measureContextUsage([], '', { contextWindow: 10000, maxOutput: 1000 }, {
    latestCall: {
      input: 1000, cacheRead: 400, cacheWrite: 100,
      output: 10, modelId: 'model', contextWindow: 10000,
    },
  });
  assert.equal(usage.uncachedInput, 600);
  assert.equal(usage.cachedInput, 400);
  assert.equal(usage.output, 10);
  assert.equal(usage.total, 1010);
});

test('a call without cache splits still accounts for its whole prompt', () => {
  const usage = measureContextUsage([], '', { contextWindow: 128000, maxOutput: 4096 }, {
    latestCall: { input: 80000, output: 4000, modelId: 'model', contextWindow: 128000 },
  });
  assert.equal(usage.uncachedInput, 80000);
  assert.equal(usage.cachedInput, 0);
  assert.equal(usage.total, 84000);
});
