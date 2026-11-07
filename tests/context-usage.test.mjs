import assert from 'node:assert/strict';
import { test } from 'node:test';

import { measureContextUsage } from '../src/features/chat/context-usage.ts';

test('context usage splits estimated input and output against the model window', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'a'.repeat(400) },
    { id: 'a1', role: 'assistant', content: 'a'.repeat(200) },
    { id: 'u2', role: 'user', content: '你好' },
  ];
  const usage = measureContextUsage(messages, 'system', { contextWindow: 10_000, maxOutput: 1_000 });

  // system 2 + user (8 + 100) + user (8 + 3); assistant (8 + 50).
  assert.equal(usage.input, 121);
  assert.equal(usage.output, 58);
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
  assert.ok(withTools.input > plain.input + 2000);
  const summarized = measureContextUsage(messages, '', config, { summary: { coveredUntilMessageId: 'old', summary: 'short' } });
  assert.ok(summarized.total < plain.total);
});

test('the current call uses provider input including cache, not cumulative billing', () => {
  const usage = measureContextUsage([], '', { contextWindow: 128000, maxOutput: 4096 }, {
    latestCall: { input: 80000, output: 4000, modelId: 'model', contextWindow: 128000 },
  });
  assert.equal(usage.total, 84000);
  assert.equal(usage.percent, 66);
});
