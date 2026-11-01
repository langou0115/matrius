import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';

import { createReplyRun } from '../src/core/agent/runner.ts';
import { createReplyDiagnostics, replyDiagnostics } from '../src/core/agent/diagnostics.ts';

const config = {
  id: 'test', name: 'Test', modelId: 'test-model', protocol: 'completion',
  providerId: 'test', providerName: 'Test', baseUrl: 'https://test.invalid/v1',
  contextWindow: 128000, maxOutput: 4096, requiresApiKey: true, supportsImage: false,
};
const messages = [{ id: 'u1', role: 'user', content: 'PRIVATE_USER_TEXT' }];

function assistant(content, stopReason) {
  const message = { role: 'assistant', content, stopReason, api: 'openai-completions',
    provider: 'test', model: 'test-model', timestamp: Date.now(),
    usage: { input: 12, output: 4096, cacheRead: 0, cacheWrite: 0, totalTokens: 4108,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: stopReason, message });
  return stream;
}

test('output limits, thinking-only replies and empty replies have distinct diagnoses without retaining secrets', async () => {
  replyDiagnostics.clear();
  const original = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  try {
    for (const [content, reason, expectedStatus, expectedError, outcome] of [
      [[{ type: 'thinking', thinking: 'PRIVATE_THINKING' }], 'length', 'error', /最大输出长度/, 'output_limit'],
      [[{ type: 'text', text: 'PRIVATE_ANSWER' }], 'length', 'complete', /最大输出长度/, 'output_limit'],
      [[{ type: 'thinking', thinking: 'PRIVATE_THINKING' }], 'stop', 'error', /仅返回了思考/, 'no_final_text'],
      [[], 'stop', 'error', /没有回答正文/, 'no_final_text'],
    ]) {
      const result = await createReplyRun({ config, apiKey: 'PRIVATE_KEY', messages, onUpdate() {},
        streamFn: () => assistant(content, reason) }).start();
      assert.equal(result.status, expectedStatus);
      assert.match(result.error, expectedError);
      const trace = JSON.parse(replyDiagnostics.export()).runs.at(-1);
      const ended = trace.entries.find((entry) => entry.event === 'message_end');
      assert.equal(ended.stopReason, reason);
      assert.equal(ended.usage.output, 4096);
      assert.equal(trace.entries.at(-1).outcome, outcome);
    }
    assert.equal(logs.length, 4);
    const exported = replyDiagnostics.export();
    assert(!exported.includes('PRIVATE_'));
    assert(!JSON.stringify(logs).includes('PRIVATE_'));
  } finally { console.info = original; }
});

test('diagnostic hooks preserve payload overrides and response callbacks, retaining only limits and request IDs', async () => {
  replyDiagnostics.clear();
  const diagnostics = createReplyDiagnostics(config, 'high');
  const replacement = { max_tokens: 8000, thinking: { budget_tokens: 2000 }, messages: ['PRIVATE_MESSAGE'] };
  let received = false;
  const wrapped = diagnostics.stream(async (model, _context, options) => {
    assert.equal(options.apiKey, 'PRIVATE_KEY');
    assert.equal(await options.onPayload({ max_tokens: 1234, secret: 'PRIVATE_PAYLOAD' }, model), replacement);
    await options.onResponse({ status: 200, headers: {
      'X-Request-ID': 'req_test', authorization: 'PRIVATE_AUTH', 'set-cookie': 'PRIVATE_COOKIE',
    } }, model);
    return assistant([], 'stop');
  });
  await wrapped({ api: 'openai-completions' }, {}, {
    apiKey: 'PRIVATE_KEY', onPayload: () => replacement, onResponse: () => { received = true; },
  });
  assert.equal(received, true);
  const trace = JSON.parse(replyDiagnostics.export()).runs[0];
  assert.equal(trace.thinkingEffort, 'high');
  const limits = trace.entries.find((entry) => entry.event === 'payload_limits');
  assert.equal(limits.maxTokens, 8000);
  assert.equal(limits.thinkingBudget, 2000);
  const response = trace.entries.find((entry) => entry.event === 'response');
  assert.equal(response.status, 200);
  assert.equal(response.requestId, 'req_test');
  assert(!replyDiagnostics.export().includes('PRIVATE_'));
});

test('HTTP failures retain a status code but never the provider error body or key', async () => {
  replyDiagnostics.clear();
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const logs = [];
  console.info = (...args) => logs.push(args);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: {
    message: 'PRIVATE_PROVIDER_BODY PRIVATE_KEY', type: 'authentication_error',
  } }), { status: 401, headers: { 'content-type': 'application/json' } });
  try {
    const result = await createReplyRun({ config, apiKey: 'PRIVATE_KEY', messages, onUpdate() {} }).start();
    assert.equal(result.status, 'error');
    assert.match(result.error, /认证失败/);
    const entries = JSON.parse(replyDiagnostics.export()).runs[0].entries;
    assert.equal(entries.find((entry) => entry.event === 'message_end').httpErrorStatus, 401);
    assert.equal(entries.at(-1).outcome, 'provider_error');
    assert(!JSON.stringify(logs).includes('PRIVATE_'));
    assert(!replyDiagnostics.export().includes('PRIVATE_'));
  } finally { globalThis.fetch = originalFetch; console.info = originalInfo; }
});

test('diagnostic history bounds both runs and per-run events and supports clearing', () => {
  replyDiagnostics.clear();
  for (let run = 0; run < 25; run++) {
    const diagnostics = createReplyDiagnostics(config, 'default');
    for (let event = 0; event < 110; event++) diagnostics.toolEnd(false);
  }
  const traces = JSON.parse(globalThis.matriusDiagnostics.export()).runs;
  assert.equal(traces.length, 20);
  assert.equal(traces.at(-1).entries.length, 100);
  globalThis.matriusDiagnostics.clear();
  assert.deepEqual(JSON.parse(replyDiagnostics.export()).runs, []);
});

test('a tool round followed by thinking-only truncation preserves earlier progress and records the failing round', async () => {
  replyDiagnostics.clear();
  let calls = 0;
  const updates = [];
  const original = console.info;
  console.info = () => {};
  try {
    const result = await createReplyRun({ config, apiKey: 'PRIVATE_KEY', messages, onUpdate: (value) => updates.push(value),
      tools: [{ name: 'file', label: 'File', description: 'Test', parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }], details: {} }) }],
      streamFn: () => ++calls === 1
        ? assistant([{ type: 'text', text: '正在创建。' }, { type: 'toolCall', id: 'test_call', name: 'file', arguments: {} }], 'toolUse')
        : assistant([{ type: 'thinking', thinking: 'PRIVATE_THINKING' }], 'length'),
    }).start();
    assert.equal(result.status, 'error');
    assert.match(result.error, /最大输出长度/);
    assert.equal(updates.at(-1).content, '正在创建。');
    const entries = JSON.parse(replyDiagnostics.export()).runs[0].entries;
    assert.deepEqual(entries.filter((entry) => entry.event === 'message_end').map((entry) => entry.stopReason), ['toolUse', 'length']);
    assert.equal(entries.find((entry) => entry.event === 'tool_end').isError, false);
    assert.equal(entries.at(-1).rounds, 2);
    assert(!replyDiagnostics.export().includes('PRIVATE_'));
  } finally { console.info = original; }
});

test('real provider transports report HTTP metadata and effective payload limits for all three protocols', async (t) => {
  for (const protocol of ['completion', 'responses', 'message']) await t.test(protocol, async () => {
    replyDiagnostics.clear();
    const originalFetch = globalThis.fetch;
    const originalInfo = console.info;
    console.info = () => {};
    const events = protocol === 'completion' ? [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'PRIVATE_ANSWER' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
    ] : protocol === 'message' ? [
      { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'test-model', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PRIVATE_ANSWER' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ] : [
      { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', content: [], status: 'in_progress' } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'PRIVATE_ANSWER' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_ANSWER', annotations: [] }], status: 'completed' } },
      { type: 'response.completed', response: { id: 'resp_test', status: 'completed', usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } },
    ];
    let payload;
    globalThis.fetch = async (_url, init) => {
      payload = JSON.parse(init.body);
      const source = events.map((event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
      return new Response(source, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_provider', 'set-cookie': 'PRIVATE_COOKIE' } });
    };
    try {
      const result = await createReplyRun({ config: { ...config, protocol }, apiKey: 'PRIVATE_KEY', messages, onUpdate() {} }).start();
      assert.equal(result.status, 'complete');
      const entries = JSON.parse(replyDiagnostics.export()).runs[0].entries;
      assert.equal(entries.find((entry) => entry.event === 'response').requestId, 'req_provider');
      const limits = entries.find((entry) => entry.event === 'payload_limits');
      assert.equal(limits.maxTokens ?? limits.maxCompletionTokens ?? limits.maxOutputTokens,
        payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens);
      assert.equal(entries.find((entry) => entry.event === 'message_end').usage.output, 2);
      assert(!replyDiagnostics.export().includes('PRIVATE_'));
    } finally { globalThis.fetch = originalFetch; console.info = originalInfo; }
  });
});
