import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplyRun, buildContext, describeModelError } from '../src/core/agent/runner.ts';
import { validateModelConfig, createAgentModel } from '../src/core/llm/model-config.ts';
import { createModelCredentials } from '../src/core/platform/model-credentials.ts';
import { searchSettings } from '../src/features/settings/settings-catalog.ts';

const config = { id: 'test', name: 'Test model', protocol: 'completion', baseUrl: 'https://test.invalid/v1', modelId: 'test-model', contextWindow: 128000, maxOutput: 4096, requiresApiKey: true };
const history = [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '先前的回答', reasoning: 'do not resend hidden thinking' }, { id: 'u2', role: 'user', content: '继续' }];
function events(protocol) {
  if (protocol === 'completion') return [
    { choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: '，世界' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  if (protocol === 'message') return [
    { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'test-model', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '，世界' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return [
    { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', content: [], status: 'in_progress' } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '你好' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '，世界' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '你好，世界' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好，世界', annotations: [] }], status: 'completed' } },
    { type: 'response.completed', response: { id: 'resp_test', status: 'completed', usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
  ];
}
function response(protocol, signal, hang = false) {
  const source = events(protocol).map((event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(hang ? source.slice(0, source.indexOf('\n\n') + 2) : source);
  return new Response(new ReadableStream({
    start(controller) {
      // Deliberately split SSE fields and UTF-8 sequences across tiny chunks.
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      if (hang) signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      else controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('three real pi providers stream text and preserve multi-turn context without tools', async (t) => {
  for (const protocol of ['completion', 'responses', 'message']) await t.test(protocol, async () => {
    const original = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), init, body: JSON.parse(init.body) };
      return response(protocol, init.signal);
    };
    const updates = [];
    try {
      const run = createReplyRun({ config: { ...config, protocol, baseUrl: protocol === 'message' ? 'https://test.invalid' : config.baseUrl }, apiKey: 'test-session-key', messages: history, onUpdate: value => updates.push(value) });
      assert.equal((await run.start()).status, 'complete');
      assert.equal(updates.at(-1).content, '你好，世界');
      assert.ok(updates.some(value => value.content === '你好'));
      assert.match(request.url, protocol === 'completion' ? /\/v1\/chat\/completions$/ : protocol === 'responses' ? /\/v1\/responses$/ : /\/v1\/messages$/);
      assert.equal(request.body.model, 'test-model');
      assert.equal(request.body.stream, true);
      const payload = JSON.stringify(request.body);
      assert.ok(payload.includes('先前的回答'));
      assert.ok(payload.includes('继续'));
      assert.ok(!payload.includes('do not resend hidden thinking'));
      assert.ok(!request.body.tools?.length);
      const headers = new Headers(request.init.headers);
      assert.equal(protocol === 'message' ? headers.get('x-api-key') : headers.get('authorization'), protocol === 'message' ? 'test-session-key' : 'Bearer test-session-key');
    } finally { globalThis.fetch = original; }
  });
});

test('stop keeps partial text and cancels the provider request', async () => {
  const original = globalThis.fetch;
  let signal;
  globalThis.fetch = async (_url, init) => { signal = init.signal; return response('completion', signal, true); };
  const updates = [];
  let run;
  try {
    run = createReplyRun({ config, apiKey: 'test-key', messages: history, onUpdate: value => { updates.push(value); if (value.content) run.abort(); } });
    assert.equal((await run.start()).status, 'stopped');
    assert.equal(updates.at(-1).content, '你好');
    assert.equal(signal.aborted, true);
  } finally { globalThis.fetch = original; }
});

test('timeouts terminate requests; authentication failures do not expose provider errors or keys', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => response('completion', init.signal, true);
    const timed = await createReplyRun({ config, apiKey: 'test-key', messages: history, onUpdate() {}, timeoutMs: 30 }).start();
    assert.equal(timed.status, 'error');
    assert.match(timed.error, /超时/);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: '401 leaked-secret-value', type: 'authentication_error' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    const failed = await createReplyRun({ config, apiKey: 'leaked-secret-value', messages: history, onUpdate() {} }).start();
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /认证失败/);
    assert.ok(!failed.error.includes('leaked-secret-value'));
  } finally { globalThis.fetch = original; }
});

test('model metadata whitelists fields and credentials stay isolated in memory', () => {
  const normalized = validateModelConfig({ ...config, apiKey: 'must-not-persist' });
  assert.ok(!JSON.stringify(normalized).includes('must-not-persist'));
  assert.equal(createAgentModel(normalized).api, 'openai-completions');
  assert.deepEqual(createAgentModel(normalized).input, ['text']);
  for (const baseUrl of ['javascript:alert(1)', 'https://u:secret@test.invalid', 'https://test.invalid?key=secret']) assert.throws(() => validateModelConfig({ ...config, baseUrl }));
  assert.throws(() => validateModelConfig({ ...config, maxOutput: config.contextWindow }));
  const local = createModelCredentials();
  const mock = createModelCredentials();
  local.set('test', 'secret');
  assert.equal(mock.get('test'), '');
  local.clear(); assert.equal(local.get('test'), '');
  assert.ok(!JSON.stringify(buildContext(history, config)).includes('hidden thinking'));
  assert.deepEqual(searchSettings('暗色').map(item => item.id), ['appearance']);
  assert.deepEqual(searchSettings('Twitter').map(item => item.id), ['appearance']);
  assert.deepEqual(searchSettings('API key').map(item => item.id), ['models']);
  assert.match(describeModelError(new Error('429 secret')), /额度/);
});

test('workspace runtime keeps generations attached to their source conversation and does not resurrect deleted chats', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../src/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../src/features/models/model-state.tsx');
  const { ChatRuntimeProvider, useChatRuntime } = await import('../src/features/chat/chat-runtime.tsx');
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let chat, models, runtime;
  let requestSignal;
  globalThis.fetch = async (_url, init) => { requestSignal = init.signal; return response('completion', init.signal, true); };
  function Harness() { chat = useChat(); models = useModels(); runtime = useChatRuntime(); return null; }
  async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.ok(predicate(), 'expected runtime transition');
  }
  try {
    await act(async () => { root.render(createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(ChatRuntimeProvider, null, createElement(Harness))))); });
    await act(async () => { assert.equal(runtime.send('keep this draft', null), false); });
    assert.equal(chat.conversations.length, 0);
    await act(async () => { await models.save(config, 'key'); });
    await act(async () => { assert.equal(runtime.send('first message', null), true); assert.equal(runtime.send('double submission', null), false); });
    const sourceId = chat.activeId;
    await until(() => requestSignal && chat.conversations[0].messages.length === 2);
    await act(async () => { chat.dispatch({ type: 'select', id: null }); });
    assert.equal(chat.activeId, null);
    await act(async () => { runtime.stop(); });
    await until(() => runtime.runningId === null);
    assert.equal(chat.activeId, null, 'reply updates must not navigate back to their source');
    assert.equal(chat.conversations[0].messages[1].content, '你好');
    assert.equal(chat.conversations[0].messages[1].status, 'stopped');
    requestSignal = undefined;
    await act(async () => { runtime.retry(sourceId); });
    await until(() => requestSignal && runtime.runningId === sourceId);
    await act(async () => { chat.dispatch({ type: 'delete', id: sourceId }); });
    await until(() => runtime.runningId === null);
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(chat.conversations, []);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
