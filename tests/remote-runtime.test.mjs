import assert from 'node:assert/strict';
import test from 'node:test';

import { createRemoteAgentRuntime } from '../ui/core/agent/remote-runtime.ts';

const MODEL = {
  id: 'model-1',
  name: 'Test model',
  modelId: 'test-model',
  providerId: 'provider-1',
  providerName: 'Provider',
  protocol: 'completion',
  baseUrl: 'https://api.example.com/v1',
  requiresApiKey: true,
  supportsImage: false,
  contextWindow: 128_000,
  maxOutput: 4_096,
};

function request(overrides = {}) {
  return {
    conversationId: 'conversation-1',
    replyId: 'reply-1',
    messages: [{ id: 'user-1', role: 'user', content: 'hello' }],
    config: MODEL,
    apiKey: 'secret',
    systemPrompt: 'system',
    ...overrides,
  };
}

function sseResponse(events) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for remote runtime');
}

test('the remote runtime posts one run and applies SSE updates, summary and usage', async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return sseResponse([
      { type: 'run', runId: 'run-1', conversationId: 'conversation-1', replyId: 'reply-1' },
      {
        type: 'update',
        update: {
          content: 'Hello',
          reasoning: 'thinking',
          reasoningActive: true,
          activities: [],
        },
      },
      {
        type: 'summary',
        contextSummary: { coveredUntilMessageId: 'user-1', summary: 'covered' },
      },
      {
        type: 'end',
        result: {
          status: 'complete',
          usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        },
      },
    ]);
  };
  try {
    const replies = [];
    const summaries = [];
    const usages = [];
    const runtime = createRemoteAgentRuntime({
      onReply: (conversationId, message) => replies.push({ conversationId, message }),
      onSummary: (conversationId, summary) => summaries.push({ conversationId, summary }),
      onUsage: (usage) => usages.push(usage),
    });
    assert.equal(runtime.start(request()), true);
    await waitFor(() => replies.some((item) => item.message.status === 'complete'));

    const final = replies.at(-1);
    assert.equal(final.conversationId, 'conversation-1');
    assert.equal(final.message.content, 'Hello');
    assert.equal(final.message.status, 'complete');
    assert.equal(final.message.reasoning, 'thinking');
    assert.equal(final.message.reasoningActive, false);
    assert.deepEqual(summaries, [{
      conversationId: 'conversation-1',
      summary: { coveredUntilMessageId: 'user-1', summary: 'covered' },
    }]);
    assert.deepEqual(usages, [{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }]);

    assert.equal(captured.url, '/api/agent/runs');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.conversationId, 'conversation-1');
    assert.equal(body.apiKey, 'secret');
    assert.equal(body.model.modelId, 'test-model');
    assert.deepEqual(runtime.getSnapshot().runs, {});
    runtime.dispose();
  } finally {
    globalThis.fetch = original;
  }
});

test('the remote runtime surfaces an HTTP error on the assistant message', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: 'run_in_progress', message: '当前会话正在生成回复。' },
  }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  try {
    const replies = [];
    const runtime = createRemoteAgentRuntime({
      onReply: (_conversationId, message) => replies.push(message),
    });
    assert.equal(runtime.start(request()), true);
    await waitFor(() => replies.some((message) => message.status === 'error'));
    assert.equal(replies.at(-1).error, '当前会话正在生成回复。');
    assert.deepEqual(runtime.getSnapshot().runs, {});
    runtime.dispose();
  } finally {
    globalThis.fetch = original;
  }
});
