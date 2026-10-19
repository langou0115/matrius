import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplyRun, describeModelError } from '../src/core/agent/runner.ts';
import { buildContext, buildRetryHistory, validateAgentRequest } from '../src/core/agent/context.ts';
import { withoutFailedTurn } from '../src/core/agent/history.ts';
import { createAgentRuntime } from '../src/core/agent/runtime.ts';
import { validateModelConfig, createAgentModel } from '../src/core/llm/model-config.ts';
import { fetchProviderCatalog } from '../src/core/llm/provider-catalog.web.ts';
import { createModelCredentials } from '../src/core/platform/model-credentials.ts';
import { searchSettings } from '../src/features/settings/settings-catalog.ts';
import { PersonalizationProvider, usePersonalization } from '../src/features/settings/personalization-state.tsx';
import { defaultPersonalization, readPersonalization } from '../src/features/settings/personalization.ts';
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from '../src/core/agent/system-prompt.ts';

const config = { id: 'test', name: 'Test model', protocol: 'completion', baseUrl: 'https://test.invalid/v1', modelId: 'test-model', contextWindow: 128000, maxOutput: 4096, requiresApiKey: true };
const history = [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '先前的回答', reasoning: 'do not resend hidden thinking' }, { id: 'u2', role: 'user', content: '继续', quote: '选中的历史回复\n第二段引用' }];

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

test('shared runtime works without a UI, freezes request inputs and preserves partial replies on cancellation', async () => {
  const completion = deferred();
  const loaded = deferred();
  const finished = deferred();
  const replies = [];
  let request, aborts = 0, notifications = 0;
  const runtime = createAgentRuntime({
    onReply(conversationId, message) { replies.push({ conversationId, message }); if (message.status !== 'streaming') finished.resolve(); },
    loadRunner: async () => ({ createReplyRun(options) {
      request = options;
      loaded.resolve();
      options.onUpdate({ content: 'partial answer', reasoning: 'actual reasoning', reasoningActive: false });
      return { abort() { aborts++; }, start: () => completion.promise };
    } }),
  });
  const unsubscribe = runtime.subscribe(() => { notifications++; });
  const requestConfig = { ...config };
  const messages = structuredClone(history);
  assert.equal(runtime.start({ conversationId: 'a', replyId: 'reply', config: requestConfig, apiKey: 'session-secret', messages }), true);
  assert.equal(runtime.getSnapshot().runningId, 'a');
  assert.equal(runtime.start({ conversationId: 'b', replyId: 'other', config, apiKey: 'key', messages: history }), false, 'one active run per workspace');
  requestConfig.modelId = 'edited-after-send';
  messages[2].quote = 'edited quote';
  await loaded.promise;
  assert.equal(request.config.modelId, 'test-model');
  assert.equal(request.messages[2].quote, '选中的历史回复\n第二段引用');
  assert.equal(replies.length, 0, 'streaming updates are batched');
  runtime.stop();
  request.onUpdate({ content: 'late answer that must be ignored', reasoning: '', reasoningActive: false });
  completion.resolve({ status: 'complete' });
  await finished.promise;
  assert.equal(aborts, 1);
  assert.equal(replies.length, 1, 'the final flush cancels the pending batch');
  assert.equal(replies[0].conversationId, 'a');
  assert.equal(replies[0].message.status, 'stopped');
  assert.equal(replies[0].message.content, 'partial answer');
  assert.ok(Number.isFinite(replies[0].message.thinkingMs));
  assert.equal(runtime.getSnapshot().runningId, null);
  assert.equal(runtime.getSnapshot().startedAt, null);
  assert.ok(!JSON.stringify(runtime.getSnapshot()).includes('session-secret'));
  assert.ok(notifications >= 2);
  unsubscribe();
  const before = notifications;
  runtime.clearError();
  assert.equal(notifications, before, 'unsubscribed clients do not receive further updates');
  runtime.dispose();
});

test('shared runtime validates requests, handles cancellation during lazy loading and discards disposed replies', async () => {
  const loader = deferred();
  const finished = deferred();
  let calls = 0, replies = 0;
  const runtime = createAgentRuntime({
    loadRunner: () => { calls++; return loader.promise; },
    onReply(_id, message) { replies++; if (message.status === 'stopped') finished.resolve(); },
  });
  const input = { conversationId: 'chat', replyId: 'reply', config, apiKey: 'key', messages: history };
  assert.equal(runtime.start({ ...input, config: undefined }), false);
  assert.match(runtime.getSnapshot().error, /配置|添加/);
  assert.equal(runtime.start({ ...input, apiKey: '' }), false);
  assert.match(runtime.getSnapshot().error, /API key/);
  assert.equal(runtime.start({ ...input, config: { ...config, contextWindow: 4200 }, messages: [{ id: 'u', role: 'user', content: 'x'.repeat(5000) }] }), false);
  assert.match(runtime.getSnapshot().error, /上下文/);
  assert.equal(calls, 0, 'validation does not load provider modules');
  assert.equal(runtime.start(input), true);
  runtime.stop();
  loader.resolve({ createReplyRun() { assert.fail('a cancelled lazy load must not create a runner'); } });
  await finished.promise;
  assert.equal(runtime.getSnapshot().runningId, null);
  assert.equal(replies, 1);
  const disposedLoader = deferred();
  const disposed = createAgentRuntime({ loadRunner: () => disposedLoader.promise, onReply() { assert.fail('disposed runtimes must not publish replies'); } });
  assert.equal(disposed.start(input), true);
  disposed.dispose();
  assert.equal(disposed.getSnapshot().runningId, null);
  disposedLoader.reject(new Error('sensitive provider failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(disposed.start(input), false);
  runtime.dispose();
});

test('agent core has no UI, feature-module or browser dependencies', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const ts = (await import('typescript')).default;
  const directory = new URL('../src/core/agent/', import.meta.url);
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, directory), 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier?.text ?? '';
        assert.ok(!/features\/|\.web(?:\.|$)|^react(?:$|-)|^expo(?:$|-)/.test(specifier), `${file} must not depend on ${specifier}`);
      }
      if (ts.isIdentifier(node)) assert.ok(!['window', 'document', 'indexedDB', 'localStorage'].includes(node.text), `${file} contains a browser dependency`);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
test('personalization defaults, limits and prompt composition keep optional sections out of empty requests', () => {
  assert.deepEqual(readPersonalization(undefined), defaultPersonalization);
  assert.equal(buildSystemPrompt(defaultPersonalization), DEFAULT_SYSTEM_PROMPT);
  assert.equal(buildSystemPrompt({ ...defaultPersonalization, customInstructions: '  \n  ' }), DEFAULT_SYSTEM_PROMPT);
  const preferences = readPersonalization({ customInstructions: '  使用中文\n先给结论  ', aboutName: '小林', memoryEnabled: true });
  assert.equal(preferences.customInstructions, '  使用中文\n先给结论  ', 'editing preserves whitespace');
  assert.equal(preferences.memoryEnabled, undefined, 'memory is outside the stored contract');
  assert.match(buildSystemPrompt(preferences), /使用中文\n先给结论/);
  assert.match(buildSystemPrompt(preferences), /称呼：小林/);
  assert.ok(!buildSystemPrompt(preferences).includes('职业：'));
  assert.throws(() => readPersonalization({ occupation: 'x'.repeat(101) }));
  assert.throws(() => readPersonalization({ customInstructions: 'x'.repeat(10001) }));
  assert.throws(() => readPersonalization({ aboutMore: 42 }));
  assert.equal(readPersonalization({ customInstructions: 'x'.repeat(10000) }).customInstructions.length, 10000);
  assert.deepEqual(searchSettings('自定义指令').map(item => item.id), ['personalization']);
});
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
      const systemPrompt = buildSystemPrompt({ customInstructions: '优先给出简洁结论', aboutName: '小林', occupation: '设计师', aboutMore: '正在学习编程' });
      const run = createReplyRun({ config: { ...config, protocol, baseUrl: protocol === 'message' ? 'https://test.invalid' : config.baseUrl }, apiKey: 'test-session-key', messages: history, systemPrompt, onUpdate: value => updates.push(value) });
      assert.equal((await run.start()).status, 'complete');
      assert.equal(updates.at(-1).content, '你好，世界');
      assert.ok(updates.some(value => value.content === '你好'));
      assert.match(request.url, protocol === 'completion' ? /\/v1\/chat\/completions$/ : protocol === 'responses' ? /\/v1\/responses$/ : /\/v1\/messages$/);
      assert.equal(request.body.model, 'test-model');
      assert.equal(request.body.stream, true);
      const payload = JSON.stringify(request.body);
      const systemPayload = JSON.stringify(protocol === 'message' ? request.body.system
        : (protocol === 'responses' ? request.body.input : request.body.messages).filter(item => item.role === 'system' || item.role === 'developer'));
      for (const preference of ['优先给出简洁结论', '小林', '设计师', '正在学习编程']) assert.ok(systemPayload.includes(preference), `${protocol} carries personalization as system instructions`);
      assert.ok(payload.includes('先前的回答'));
      assert.ok(payload.includes('继续'));
      assert.ok(payload.includes('选中的历史回复'), `${protocol} includes the selected quote`);
      assert.ok(payload.includes('仅作为参考资料'), `${protocol} separates the quote from the new instruction`);
      assert.ok(!payload.includes('do not resend hidden thinking'));
      assert.ok(!request.body.tools?.length);
      // Every protocol carries the system prompt, in a different field: `messages[0]`, `input[0]`
      // and a top-level `system`. A field left unset serialises as the string `undefined`.
      assert.ok(!payload.includes('undefined'), protocol);
      const headers = new Headers(request.init.headers);
      assert.equal(protocol === 'message' ? headers.get('x-api-key') : headers.get('authorization'), protocol === 'message' ? 'test-session-key' : 'Bearer test-session-key');
    } finally { globalThis.fetch = original; }
  });
});

test('image attachments reach every protocol as native image blocks', async (t) => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const image = { id: 'img-1', name: 'dot.png', mimeType: 'image/png', dataUrl };
  for (const protocol of ['completion', 'responses', 'message']) await t.test(protocol, async () => {
    const original = globalThis.fetch;
    let body;
    globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return response(protocol, init.signal); };
    try {
      const run = createReplyRun({
        config: { ...config, protocol, baseUrl: protocol === 'message' ? 'https://test.invalid' : config.baseUrl, supportsImage: true },
        apiKey: 'test-key',
        messages: [{ id: 'u1', role: 'user', content: '这是什么？', images: [image] }],
        onUpdate() {},
      });
      assert.equal((await run.start()).status, 'complete');
      const payload = JSON.stringify(body);
      assert.ok(payload.includes('iVBORw0KGgo'), `${protocol} carries the base64 payload`);
      assert.ok(payload.includes('这是什么？'), `${protocol} keeps the accompanying text`);
      // OpenAI's two APIs wrap the bytes in a data URL; Anthropic takes base64 plus a media type.
      assert.equal(payload.includes('data:image/png;base64'), protocol !== 'message', `${protocol} uses its native image shape`);
    } finally { globalThis.fetch = original; }
  });
});

test('good and bad feedback reach all pi providers as user feedback tied to the preceding answer', async (t) => {
  const rated = [
    { id: 'u1', role: 'user', content: 'first question' },
    { id: 'a1', role: 'assistant', content: 'first answer', feedback: 'good' },
    { id: 'u2', role: 'user', content: 'second question' },
    { id: 'a2', role: 'assistant', content: 'second answer', feedback: 'bad' },
    { id: 'u3', role: 'user', content: 'continue' },
  ];
  const context = buildContext(rated, config);
  assert.deepEqual(context.map(message => message.role), ['user', 'assistant', 'user', 'user', 'assistant', 'user', 'user']);
  assert.equal(context[1].content[0].text, 'first answer', 'feedback does not alter the assistant answer');
  assert.match(context[2].content, /赞（有帮助）/);
  assert.match(context[5].content, /踩（没有帮助）/);
  assert.equal(buildContext(rated.map(({ feedback, ...message }) => message), config).length, rated.length, 'cancelled feedback adds no context');
  assert.equal(validateAgentRequest({ ...config, contextWindow: 4700 }, 'key', rated.map(({ feedback, ...message }) => message), 'x'.repeat(30)), null);
  assert.match(validateAgentRequest({ ...config, contextWindow: 4700 }, 'key', rated, 'x'.repeat(30)), /上下文/, 'feedback is counted in the input budget');
  const retry = buildRetryHistory(rated.slice(0, -1));
  assert.equal(retry.at(-2).feedback, 'bad');
  assert.match(retry.at(-1).content, /重新回答/);
  for (const protocol of ['completion', 'responses', 'message']) await t.test(protocol, async () => {
    const previousFetch = globalThis.fetch;
    let body;
    globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return response(protocol, init.signal); };
    try {
      const run = createReplyRun({ config: { ...config, protocol, baseUrl: protocol === 'message' ? 'https://test.invalid' : config.baseUrl }, apiKey: 'test-key', messages: rated, onUpdate() {} });
      assert.equal((await run.start()).status, 'complete');
      const payload = JSON.stringify(body);
      assert.ok(payload.includes('赞（有帮助）'), `${protocol} includes positive feedback`);
      assert.ok(payload.includes('踩（没有帮助）'), `${protocol} includes negative feedback`);
      assert.ok(payload.includes('用户没有提供更具体的原因'), 'does not invent a reason for the rating');
    } finally { globalThis.fetch = previousFetch; }
  });
});

test('a failed reply never reaches the next model request', () => {
  const failed = [
    { id: 'u1', role: 'user', content: 'first question' },
    { id: 'a1', role: 'assistant', content: 'half an answer', status: 'error', error: '超时' },
  ];
  const context = buildContext(failed, config);
  assert.deepEqual(context.map(message => message.role), ['user'], 'only the original question remains');
  assert.ok(!JSON.stringify(context).includes('half an answer'), 'a partial failed reply is not replayed as an answer');
  assert.ok(!JSON.stringify(context).includes('超时'), 'the error text is not part of the conversation');
  // Continuing with a new question must not smuggle the failed turn in either.
  assert.ok(!JSON.stringify(buildContext([...failed, { id: 'u2', role: 'user', content: 'another question' }], config)).includes('half an answer'));
  assert.deepEqual(buildRetryHistory(failed).map(message => message.id), ['u1'], 'retry re-sends the original question');
  // A fresh message supersedes the failed turn: its unanswered question goes too.
  assert.deepEqual(withoutFailedTurn(failed), [], 'both the failed error and its question are dropped');
  assert.deepEqual(
    withoutFailedTurn([{ id: 'u0', role: 'user', content: 'earlier' }, { id: 'a0', role: 'assistant', content: 'answer', status: 'complete' }, ...failed]).map(message => message.id),
    ['u0', 'a0'],
    'only the failed turn is dropped; answered history stays',
  );
  // A stopped turn is different: it holds text the user may want to continue from.
  const stopped = [failed[0], { id: 'a1', role: 'assistant', content: 'partial answer', status: 'stopped' }];
  assert.ok(JSON.stringify(buildContext(stopped, config)).includes('partial answer'));
  assert.deepEqual(buildRetryHistory(stopped).map(message => message.id), ['u1']);
});

test('sending after a failure removes the whole failed turn from local history', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../src/features/chat/chat-state.tsx');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let chat;
  const initialState = {
    conversations: [{
      id: 'c1', title: 'c1', pinned: false, updatedAt: 0, errorReadAt: 1, thinkingEffort: 'default',
      messages: [
        { id: 'u1', role: 'user', content: 'question' },
        { id: 'a1', role: 'assistant', content: 'partial', status: 'error', error: '超时' },
      ],
    }],
    activeId: 'c1', sidebarOpen: true, lastThinkingEffort: 'default',
  };
  function Harness() { chat = useChat(); return null; }
  try {
    await act(async () => { root.render(createElement(ChatProvider, { initialState }, createElement(Harness))); });
    await act(async () => {
      chat.dispatch({ type: 'send', conversationId: 'c1', message: { id: 'u2', role: 'user', content: 'next' }, thinkingEffort: 'default' });
    });
    assert.deepEqual(chat.conversations[0].messages.map(message => message.id), ['u2'], 'the failed question and its error report are gone');
    assert.equal(chat.conversations[0].errorReadAt, undefined, 'the unread-error marker is cleared');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
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
  assert.equal(normalized.supportsImage, false, 'older records default to text-only');
  assert.deepEqual(createAgentModel({ ...normalized, supportsImage: true }).input, ['text', 'image']);
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
  assert.match(describeModelError(new Error('insufficient_quota')), /额度/);
  assert.match(describeModelError(new Error('429')), /限流/);
});

test('web model calls and catalog always route through the same-origin relay', async () => {
  const normalized = validateModelConfig(config);
  assert.equal(createAgentModel(normalized).baseUrl, config.baseUrl, 'native builds without a page origin stay direct');

  const originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://app.example' };
  const originalFetch = globalThis.fetch;
  try {
    const model = createAgentModel(normalized);
    assert.equal(model.baseUrl, 'https://app.example/api/model-proxy/v1');
    assert.equal(model.headers['x-matrius-target-origin'], 'https://test.invalid');

    let requestedUrl = '';
    globalThis.fetch = async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ data: [{ id: 'relay-model' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const catalog = await fetchProviderCatalog({ baseUrl: config.baseUrl, protocol: 'completion', requiresApiKey: true }, 'secret');
    assert.deepEqual(catalog, [{ id: 'relay-model', name: 'relay-model' }]);
    assert.equal(requestedUrl, 'https://app.example/api/model-proxy/v1/models');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
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
  let chat, models, runtime, personalization;
  let requestSignal;
  const requestBodies = [];
  globalThis.fetch = async (_url, init) => { requestSignal = init.signal; requestBodies.push(JSON.parse(init.body)); return response('completion', init.signal, true); };
  function Harness() { chat = useChat(); models = useModels(); runtime = useChatRuntime(); personalization = usePersonalization(); return null; }
  async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.ok(predicate(), 'expected runtime transition');
  }
  try {
    await act(async () => { root.render(createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(ChatRuntimeProvider, null, createElement(Harness)))))); });
    await act(async () => { assert.equal(runtime.send('keep this draft', null), false); });
    assert.equal(chat.conversations.length, 0);
    await act(async () => { await models.save(config, 'key'); });
    await act(async () => { personalization.update({ customInstructions: 'first preference' }); });
    await act(async () => { assert.equal(runtime.send('first message', null, 'high', [], '引用需要保留'), true); assert.equal(runtime.send('double submission', null), false); });
    const sourceId = chat.activeId;
    assert.equal(chat.conversations[0].thinkingEffort, 'high');
    assert.equal(chat.conversations[0].messages[0].quote, '引用需要保留');
    await until(() => requestSignal && chat.conversations[0].messages.length === 2);
    assert.equal(requestBodies[0].reasoning_effort, 'high');
    assert.ok(JSON.stringify(requestBodies[0]).includes('first preference'));
    await act(async () => { personalization.update({ customInstructions: 'updated preference' }); });
    await act(async () => { chat.dispatch({ type: 'select', id: null }); });
    assert.equal(chat.activeId, null);
    assert.equal(chat.lastThinkingEffort, 'high', 'a new conversation inherits the last selected effort');
    await act(async () => { runtime.stop(); });
    await until(() => runtime.runningId === null);
    assert.equal(chat.activeId, null, 'reply updates must not navigate back to their source');
    assert.equal(chat.conversations[0].messages[1].content, '你好');
    assert.equal(chat.conversations[0].messages[1].status, 'stopped');
    await act(async () => { chat.dispatch({ type: 'feedback', conversationId: sourceId, messageId: chat.conversations[0].messages[1].id, feedback: 'bad' }); });
    assert.equal(requestBodies.length, 1, 'rating an answer alone does not start a request');
    requestSignal = undefined;
    await act(async () => { runtime.retry(sourceId); });
    await until(() => requestSignal && runtime.runningId === sourceId);
    assert.equal(requestBodies[1].reasoning_effort, 'high', 'retry must keep the conversation effort');
    assert.ok(JSON.stringify(requestBodies[1]).includes('updated preference'), 'retry reads the latest personalization');
    assert.ok(JSON.stringify(requestBodies[1]).includes('引用需要保留'), 'retry includes the original quote');
    assert.ok(JSON.stringify(requestBodies[1]).includes('踩（没有帮助）'), 'retry includes feedback on the version being replaced');
    await act(async () => { chat.dispatch({ type: 'delete', id: sourceId }); });
    await until(() => runtime.runningId === null);
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(chat.conversations, []);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('conversation URLs override saved selection, follow history changes and reject missing or deleted IDs', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../src/features/chat/chat-state.tsx');
  const { useConversationRouteState } = await import('../src/features/chat/conversation-route-state.ts');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const initialState = { conversations: ['a', 'b'].map(id => ({ id, title: id, pinned: false, updatedAt: 0, messages: [] })), activeId: 'a', sidebarOpen: true, lastThinkingEffort: 'default' };
  let chat, route;
  function Harness({ id }) { chat = useChat(); route = useConversationRouteState(id); return null; }
  async function navigate(id) {
    await act(async () => { root.render(createElement(ChatProvider, { initialState }, createElement(Harness, { id }))); });
  }
  try {
    await navigate('b');
    assert.equal(chat.activeId, 'b', 'a direct URL wins over the saved active ID');
    assert.equal(route.ready, true);
    await navigate('a');
    assert.equal(chat.activeId, 'a');
    await navigate('b');
    assert.equal(chat.activeId, 'b', 'back/forward URL changes select the matching conversation');
    await act(async () => { chat.dispatch({ type: 'delete', id: 'b' }); });
    assert.equal(route.exists, false);
    assert.equal(chat.activeId, null);
    await navigate('missing');
    assert.equal(route.exists, false);
    assert.equal(chat.conversations.length, 1, 'an unknown URL never creates a conversation');
    await navigate(null);
    assert.equal(route.ready, true);
    assert.equal(chat.activeId, null);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('common file extensions use dedicated local Material icons, including uppercase and unknown formats', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { parseHTML } = await import('linkedom');
  const { existsSync } = await import('node:fs');
  const { FileTypeIcon } = await import('../src/features/chat/components/file-type-icon.web.tsx');
  const cases = [
    ['report.doc', 'word'], ['report.DOCX', 'word'], ['budget.xls', 'table'], ['budget.xlsx', 'table'],
    ['slides.ppt', 'powerpoint'], ['slides.pptx', 'powerpoint'], ['report.pdf', 'pdf'],
    ['README.md', 'markdown'], ['notes.MARKDOWN', 'markdown'], ['notes.mdx', 'markdown'],
    ['data.json', 'json'], ['source.tsx', 'typescript'], ['source.py', 'python'], ['archive.zip', 'zip'],
    ['notes.txt', 'document'], ['no-extension', 'document'], ['file.unknown', 'document'],
  ];
  for (const [name, icon] of cases) {
    const markup = renderToStaticMarkup(createElement(FileTypeIcon, { file: { name, type: '' } }));
    const { document } = parseHTML(markup);
    const image = document.querySelector('.file-type-icon');
    assert.equal(image.getAttribute('src'), `/vendor/file-icons/${icon}.svg`, name);
    assert.ok(existsSync(`public/vendor/file-icons/${icon}.svg`), `${name} resolves to a shipped asset`);
  }
});

test('composer reports validation in a compact chat notice without blocking input or losing drafts', async () => {
  const { createElement, act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider } = await import('../src/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../src/features/models/model-state.tsx');
  const { ChatRuntimeProvider } = await import('../src/features/chat/chat-runtime.tsx');
  const { Composer } = await import('../src/features/chat/components/composer.web.tsx');
  const { ChatNotice } = await import('../src/features/chat/components/chat-notice.web.tsx');
  const { conversationHref } = await import('../src/features/chat/conversation-href.ts');
  assert.equal(conversationHref(null), '/');
  assert.equal(conversationHref('a/b'), '/c/a%2Fb');
  assert.equal(conversationHref('demo', true), '/mock/chat/c/demo');
  const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.HTMLElement = window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  const root = createRoot(document.getElementById('root'));
  let models;
  let sent = 0;
  function Harness() {
    models = useModels();
    const [notice, setNotice] = useState(null);
    return createElement('div', { className: 'chat-screen' },
      createElement(ChatNotice, { message: notice, onClose: () => setNotice(null) }),
      createElement(Composer, { value: '保留草稿', onChange() {}, onSend() { sent++; return false; }, thinkingEffort: 'default', onThinkingEffortChange() {}, onNotice: setNotice }));
  }
  async function choose(file) {
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { input.dispatchEvent(new window.Event('change', { bubbles: true })); });
  }
  async function submit() {
    await act(async () => { document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); });
    assert.ok(document.querySelector('.chat-notice[role="alert"]'), 'errors appear in the chat notice card');
    assert.equal(document.querySelector('dialog'), null, 'errors do not create a modal or backdrop');
    assert.equal(document.querySelector('textarea').hasAttribute('readonly'), false, 'the input stays editable');
    assert.equal(sent, 0, 'invalid attachments never reach the runtime');
    assert.equal(document.querySelector('textarea').value, '保留草稿');
    assert.equal(document.querySelectorAll('.composer-attachment').length, 1, 'failed sends keep attachments');
  }
  async function closePopup() {
    await act(async () => { (document.querySelector('[aria-label="关闭提示"]') ?? document.querySelector('[aria-label="关闭弹窗"]')).click(); });
  }
  try {
    await act(async () => { root.render(createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(ChatRuntimeProvider, null, createElement(Harness)))))); });
    assert.equal(document.querySelector('.composer-attach').disabled, false);
    assert.equal(document.querySelector('input[type="file"]').hasAttribute('accept'), false);
    await choose(new File(['document'], 'notes.pdf', { type: 'application/pdf' }));
    assert.equal(document.querySelector('.composer-attachment').getAttribute('title'), 'notes.pdf');
    assert.equal(document.querySelector('.composer-attachment .file-type-icon').getAttribute('data-file-icon'), 'pdf');
    assert.equal(document.querySelector('.attachment-name').textContent, 'notes.pdf');
    assert.equal(document.querySelector('.attachment-meta').textContent, '8 B');
    assert.equal(document.querySelector('dialog'), null, 'selection does not validate files');
    await submit();
    assert.match(document.querySelector('.chat-notice').textContent, /添加并选择模型/);
    await closePopup();
    await act(async () => { await models.save(config, 'key'); });
    await submit();
    assert.match(document.querySelector('.chat-notice').textContent, /暂不支持文件/);
    await closePopup();
    await act(async () => { document.querySelector('.composer-attachment-remove').click(); });
    await choose(new File(['image'], 'photo.png', { type: 'image/png' }));
    assert.equal(document.querySelector('dialog'), null);
    await act(async () => { document.querySelector('.attachment-preview-trigger').click(); });
    assert.ok(document.querySelector('dialog[open].image-preview-dialog'), 'image opens a full-screen preview');
    assert.equal(document.querySelector('.image-preview-stage img').getAttribute('alt'), 'photo.png');
    assert.equal(sent, 0, 'preview does not submit the composer');
    await closePopup();
    assert.equal(document.querySelector('dialog'), null);
    assert.equal(document.querySelectorAll('.composer-attachment').length, 1, 'closing preview keeps the attachment');
    await act(async () => { document.querySelector('.attachment-preview-trigger').click(); });
    await act(async () => { document.querySelector('.image-preview-stage img').click(); });
    assert.ok(document.querySelector('dialog[open]'), 'clicking the image keeps the preview open');
    await act(async () => { document.querySelector('.image-preview-stage').click(); });
    assert.equal(document.querySelector('dialog'), null, 'clicking the surrounding mask closes the preview');
    await act(async () => { document.querySelector('.attachment-preview-trigger').click(); });
    await act(async () => { document.querySelector('dialog').dispatchEvent(new window.Event('cancel', { bubbles: true, cancelable: true })); });
    assert.equal(document.querySelector('dialog'), null, 'Escape dismisses the preview');
    assert.equal(document.querySelector('.composer-attach').disabled, false, 'text models can still select attachments');
    await submit();
    assert.match(document.querySelector('.chat-notice').textContent, /图片输入/);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.HTMLElement = previous.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('reasoning stops animating before the answer starts and preserves its own duration', async () => {
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
  // Thinking finishes well before the answer, so a duration measured to the end of the turn
  // would land near the gap while a duration measured to the last thinking token stays early.
  const gapAfterThinkingMs = 400;
  const frames = [
    { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', content: [], model: 'test-model', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想一下' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '答案' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  globalThis.fetch = async (_url, init) => {
    const encoder = new TextEncoder();
    const chunks = frames.map((frame) => encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
    let index = 0;
    return new Response(new ReadableStream({
      async pull(controller) {
        if (index === chunks.length) { controller.close(); return; }
        // Pause is the answer streaming after thinking has already stopped.
        if (index === 4) await new Promise((resolve) => setTimeout(resolve, gapAfterThinkingMs));
        controller.enqueue(chunks[index++]);
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  let chat, models, runtime;
  function Harness() { chat = useChat(); models = useModels(); runtime = useChatRuntime(); return null; }
  async function until(predicate) {
    for (let i = 0; i < 200 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.ok(predicate(), 'expected runtime transition');
  }
  try {
    await act(async () => { root.render(createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(ChatRuntimeProvider, null, createElement(Harness)))))); });
    await act(async () => { await models.save({ ...config, protocol: 'message', baseUrl: 'https://test.invalid' }, 'key'); });
    await act(async () => { assert.equal(runtime.send('问题', null, 'high'), true); });
    await until(() => chat.conversations[0]?.messages[1]?.reasoningActive === false && !!chat.conversations[0]?.messages[1]?.reasoning);
    const thinkingFinished = chat.conversations[0].messages[1];
    assert.notEqual(runtime.runningId, null, 'the request is still running after thinking_end');
    assert.equal(thinkingFinished.status, 'streaming');
    assert.equal(thinkingFinished.content, '', 'thinking ends before the first answer token');
    const { getReasoningState, ReasoningBlock } = await import('../src/features/chat/components/reasoning-block.web.tsx');
    const { renderToStaticMarkup } = await import('react-dom/server');
    assert.equal(getReasoningState(thinkingFinished), 'complete');
    const markup = renderToStaticMarkup(createElement(ReasoningBlock, { reasoning: thinkingFinished.reasoning, state: getReasoningState(thinkingFinished), elapsedMs: thinkingFinished.thinkingMs }));
    assert.ok(markup.includes('已完成思考'));
    assert.ok(!markup.includes('is-running'), 'thinking animation stops while the answer is still pending');
    assert.equal(getReasoningState({ status: 'streaming', content: '正文', reasoningActive: false }), 'complete');
    assert.equal(getReasoningState({ status: 'streaming', content: '', reasoningActive: true }), 'running');
    assert.equal(getReasoningState({ status: 'stopped', content: '' }), 'stopped');
    assert.equal(getReasoningState({ status: 'error', content: '' }), 'error');
    await until(() => runtime.runningId === null);
    const reply = chat.conversations[0].messages[1];
    assert.equal(reply.content, '答案');
    assert.equal(reply.reasoning, '先想一下');
    assert.ok(Number.isFinite(reply.thinkingMs), 'a reply with reasoning carries a measured duration');
    assert.ok(reply.thinkingMs >= 0 && reply.thinkingMs < gapAfterThinkingMs - 50,
      `duration must stop at the last thinking token, measured ${reply.thinkingMs}ms`);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
