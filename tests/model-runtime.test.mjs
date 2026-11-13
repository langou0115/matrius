import assert from 'node:assert/strict';
import test from 'node:test';

import { createReplyRun, describeModelError } from '../ui/core/agent/runner.ts';
import { buildContext, buildRetryHistory, validateAgentRequest } from '../ui/core/agent/context.ts';
import { findRecentStart, getContextBudget, prepareHistory } from '../ui/core/agent/compaction.ts';
import { withoutFailedReplies } from '../ui/core/agent/history.ts';
import { createAgentRuntime } from '../ui/core/agent/runtime.ts';
import { validateModelConfig, createAgentModel } from '../ui/core/llm/model-config.ts';
import { fetchProviderCatalog } from '../ui/core/llm/provider-catalog.ts';
import { createModelCredentials } from '../ui/core/platform/model-credentials.ts';
import { searchSettings } from '../ui/features/settings/settings-catalog.ts';
import { PersonalizationProvider, usePersonalization } from '../ui/features/settings/personalization-state.tsx';
import { MemoryProvider } from '../ui/features/memory/memory-state.tsx';
import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { NetworkToolsProvider } from '../ui/features/instance/network-tools-state.tsx';
import { defaultPersonalization, readPersonalization } from '../ui/features/settings/personalization.ts';
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, withCurrentContext } from '../ui/core/agent/system-prompt.ts';
import { TITLE_SYSTEM_PROMPT, generateConversationTitle, normalizeConversationTitle } from '../ui/core/agent/title.ts';
import { generateMemorySummary } from '../ui/core/agent/memory.ts';
import { createWebTools, getWebActivityEnd, getWebActivityStart, webToolsSystemPrompt } from '../ui/core/agent/web-tools.ts';
import { createRunProtection, hasActiveBrowserRun } from '../ui/core/platform/run-protection.ts';
import { ApiError } from '../ui/core/api/instance-client.ts';
import { parseWorkspace } from '../ui/features/workspace/workspace-repository.ts';

// The provider defaults to the remote SSE runtime; these tests exercise the
// browser runtime directly, so inject it explicitly.
const runtimeFactory = createAgentRuntime;
const titleGenerator = generateConversationTitle;
const memoryGenerator = generateMemorySummary;

test('a late sync response cannot resurrect a deleted conversation, including after restoring the workspace', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const conversation = { id: 'deleted', title: 'old', pinned: false, updatedAt: 1, messages: [] };
  let chat;
  function Harness() { chat = useChat(); return null; }
  try {
    await act(async () => root.render(createElement(ChatProvider, { initialState: { conversations: [conversation], activeId: 'deleted', sidebarOpen: true } }, createElement(Harness))));
    await act(async () => chat.dispatch({ type: 'delete', id: 'deleted' }));
    await act(async () => chat.dispatch({ type: 'merge-sync', conversations: [conversation] }));
    assert.deepEqual(chat.conversations, []);
    assert.deepEqual(chat.deletedConversationIds, ['deleted']);
    assert.equal(chat.activeId, null);
    await act(async () => root.render(createElement(ChatProvider, { key: 'reload', initialState: { conversations: [], deletedConversationIds: ['deleted'], activeId: null, sidebarOpen: true } }, createElement(Harness))));
    await act(async () => chat.dispatch({ type: 'merge-sync', conversations: [conversation, { ...conversation, id: 'other' }] }));
    assert.deepEqual(chat.conversations.map(item => item.id), ['other']);
    await act(async () => chat.dispatch({ type: 'select', id: 'other' }));
    await act(async () => chat.dispatch({ type: 'merge-sync', conversations: [], deletedConversationIds: ['other'] }));
    assert.deepEqual(chat.conversations, []);
    assert.equal(chat.activeId, null);
    assert.deepEqual(new Set(chat.deletedConversationIds), new Set(['deleted', 'other']));
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('live replies pause development updates and protect navigation until every run is idle', async () => {
  const listeners = new Map();
  let pauses = 0;
  let resumes = 0;
  const protection = createRunProtection({
    target: { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: (name) => listeners.delete(name) },
    refresh: { disable: () => pauses++, enable: () => resumes++ }, resumeDelayMs: 15,
  });
  let prevented = false;
  const event = { preventDefault: () => { prevented = true; }, returnValue: undefined };
  protection.setActive(true);
  listeners.get('beforeunload')(event);
  assert.equal(prevented, true);
  assert.equal(pauses, 1);
  assert.equal(hasActiveBrowserRun(), true);
  protection.setActive(false);
  assert.equal(hasActiveBrowserRun(), false);
  protection.setActive(true);
  await new Promise((accept) => setTimeout(accept, 30));
  assert.equal(resumes, 0, 'a new run cancels the pending update release');
  protection.setActive(false);
  prevented = false;
  listeners.get('beforeunload')(event);
  assert.equal(prevented, false);
  await new Promise((accept) => setTimeout(accept, 30));
  assert.equal(resumes, 1);
  protection.dispose();
  assert.equal(listeners.size, 0);
});

test('web tools are preferred over memory unless the task needs no outside facts', () => {
  const prompt = webToolsSystemPrompt();
  assert.match(prompt, /Prefer them over answering from memory/);
  assert.match(prompt, /Search before answering/);
  assert.match(prompt, /Answer directly only for simple tasks/);
  assert.match(prompt, /current, changing or externally verifiable facts/);
  assert.match(prompt, /use English for software, developer tools, products, releases, science and international news/);
  assert.match(prompt, /use Chinese for Chinese local policies, places, Chinese-language media and China-specific products/);
  assert.match(prompt, /One search plus one batch read is usually enough/);
  assert.match(prompt, /Batch every URL you need into one web_fetch call/);
  assert.match(prompt, /pass up to four different queries in one web_search queries array/);
  assert.match(prompt, /instead of making one more fetch just to strengthen the answer/);
  assert.match(prompt, /Stop searching and reading as soon as the evidence supports an answer/);
  assert.match(prompt, /GitHub-style footnote markers/);
  assert.match(prompt, /\[\^1\]: \[Page title\]\(https:\/\/full-page-url\)/);
  assert.match(prompt, /app renders the source list itself/);
});

test('search tool description carries the topic-based language rule', () => {
  const tools = createWebTools(async () => ({ results: [] }));
  assert.match(tools[0].description, /Write software, product, release, science and international-news queries in English/);
  assert.match(tools[0].description, /Chinese local policy, place and China-specific queries in Chinese/);
});

test('one search asks the server for the merged 30-result window', async () => {
  let body;
  const tools = createWebTools(async (_path, init) => {
    body = JSON.parse(init.body);
    return { results: [] };
  });
  await tools[0].execute('search', { query: 'OpenClaw latest version' });
  assert.equal(body.limit, 30);
  assert.deepEqual(body.queries, ['OpenClaw latest version']);
});

test('one search can send four queries and keeps them in the activity', async () => {
  let body;
  const tools = createWebTools(async (_path, init) => {
    body = JSON.parse(init.body);
    return { query: 'first', queries: ['first', 'second'], results: [
      { title: 'Result', url: 'https://example.com/a', snippet: 'Snippet', domain: 'example.com', engine: 'test', rank: 1 },
    ] };
  });
  const queries = ['first', 'second', 'third', 'fourth'];
  const result = await tools[0].execute('search', { queries });
  assert.deepEqual(body.queries, queries);
  assert.deepEqual(result.details.queries, queries);
  assert.match(result.content[0].text, /Web search results for: first \/ second \/ third \/ fourth/);
  const activity = getWebActivityStart('web_search', 'search-1', { queries });
  assert.deepEqual(activity.queries, queries, 'every keyword stays available for debugging');
});

test('web tool results carry stop guidance instead of a remaining budget that invites more calls', async () => {
  const tools = createWebTools(async (path, init) => path.endsWith('/search')
    ? { results: [] }
    : { url: JSON.parse(init.body).url, title: 'Page', text: 'Page text' });
  const search = await tools[0].execute('search', { query: 'OpenClaw' });
  const fetched = await tools[1].execute('fetch', { url: 'https://example.com/a' });
  const text = [...search.content, ...fetched.content].map((item) => item.text).join('\n');
  assert.doesNotMatch(text, /Remaining web budget/i);
  assert.match(text, /answer now|stop searching/i);
});

test('a one-item urls array fetches a single page instead of failing schema validation', async () => {
  const requested = [];
  const tools = createWebTools(async (_path, init) => {
    requested.push(JSON.parse(init.body).url);
    return { url: 'https://example.com/a', title: 'A', text: 'Only page' };
  });
  assert.equal(tools[1].parameters.properties.urls.minItems, 1);
  const result = await tools[1].execute('single', { urls: ['https://example.com/a'] });
  assert.deepEqual(requested, ['https://example.com/a']);
  assert.match(result.content[0].text, /Fetched webpage: A/);
  assert.deepEqual(result.details.urls, ['https://example.com/a']);
});

test('batch fetch exposes only successful sources and warns about missing and truncated evidence', async () => {
  const tools = createWebTools(async (_path, init) => {
    const { url } = JSON.parse(init.body);
    if (url.includes('broken')) throw new Error('upstream failed');
    return { url: 'https://example.com/redirected', title: 'Document', text: 'Partial document', truncated: true };
  });
  const result = await tools[1].execute('fetch1', { urls: ['https://example.com/good', 'https://example.com/broken'] });
  const activity = getWebActivityEnd('web_fetch', 'fetch1', result, false);
  assert.deepEqual(activity.urls, ['https://example.com/redirected']);
  assert.equal(activity.status, 'complete');
  assert.match(activity.error, /1 个网页未能读取/);
  assert.match(result.content[0].text, /truncated/);
  assert.match(result.content[1].text, /Do not cite this URL/);
});

test('a four-page fetch starts every request before any page resolves and preserves partial results in URL order', async () => {
  const urls = ['one', 'two', 'three', 'four'].map((name) => `https://example.com/${name}`);
  const pending = new Map();
  const tools = createWebTools((_path, init) => new Promise((resolve, reject) => {
    pending.set(JSON.parse(init.body).url, { resolve, reject });
  }));
  const resultPromise = tools[1].execute('parallel', { urls });
  assert.equal(pending.size, 4, 'four HTTP requests must be in flight before the first response');
  assert.equal(tools[1].executionMode, 'sequential', 'model batches serialize while the four pages inside a batch run concurrently');
  for (const url of [urls[3], urls[1], urls[0]]) pending.get(url).resolve({ url, title: url, text: 'Page text' });
  pending.get(urls[2]).reject(new Error('one page failed'));
  const result = await resultPromise;
  assert.deepEqual(result.details.urls, [urls[0], urls[1], urls[3]]);
  assert.match(result.details.warning, /1 个网页未能读取/);
  assert.match(result.content[2].text, /Could not fetch/);
});

test('cancelling a parallel fetch aborts all four in-flight requests', async () => {
  const controller = new AbortController();
  let started = 0;
  let aborted = 0;
  const tools = createWebTools((_path, init) => new Promise((_resolve, reject) => {
    started++;
    init.signal.addEventListener('abort', () => { aborted++; reject(new DOMException('cancelled', 'AbortError')); }, { once: true });
  }));
  const result = tools[1].execute('cancel', { urls: ['a', 'b', 'c', 'd'].map((name) => `https://example.com/${name}`) }, controller.signal);
  assert.equal(started, 4);
  controller.abort();
  await assert.rejects(result, /取消/);
  assert.equal(aborted, 4);
});

test('transient web failures recover once without consuming another model tool call', async () => {
  let attempts = 0;
  const tools = createWebTools(async () => {
    if (++attempts === 1) throw new ApiError(503, 'busy', 'Temporary failure', 0);
    return { results: [] };
  });
  await tools[0].execute('search', { query: 'Python' });
  assert.equal(attempts, 2);
  let forbiddenAttempts = 0;
  const forbidden = createWebTools(async () => { forbiddenAttempts++; throw new ApiError(403, 'forbidden', 'Denied'); });
  await assert.rejects(forbidden[0].execute('denied', { query: 'Python' }), /Denied/);
  assert.equal(forbiddenAttempts, 1);
});

test('a short retry-after is honoured but cancelling the delay makes no second request', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const tools = createWebTools(async () => { attempts++; throw new ApiError(429, 'rate_limited', 'Busy', 5000); });
  const result = tools[0].execute('search', { query: 'Python' }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(result, /取消/);
  assert.equal(attempts, 1);
});

test('the client does not retry a failed page; the API owns the fetch retry budget', async () => {
  let attempts = 0;
  const tools = createWebTools(async () => {
    attempts += 1;
    throw new ApiError(503, 'busy', 'Temporary failure', 0);
  });
  await assert.rejects(tools[1].execute('fetch', { url: 'https://example.com/a' }), /Temporary failure/);
  assert.equal(attempts, 1, 'one failed page must not be requested twice');
});

test('multi-page results use OpenStudio-sized excerpts instead of overflowing the next model context', async () => {
  const tools = createWebTools(async (_path, init) => ({ url: JSON.parse(init.body).url, title: 'Page', text: 'x'.repeat(50_000) }));
  const result = await tools[1].execute('fetch', { urls: ['https://example.com/a', 'https://example.com/b'] });
  assert.ok(result.content[0].text.length < 16_300);
  assert.match(result.content[0].text, /truncated/);
});

test('a ten-page fetch starts all ten requests and shares one content budget', async () => {
  const urls = Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`);
  const pending = new Map();
  const tools = createWebTools((_path, init) => new Promise((resolve) => {
    pending.set(JSON.parse(init.body).url, resolve);
  }));
  const resultPromise = tools[1].execute('ten', { urls });
  assert.equal(pending.size, 10, 'ten requests must be in flight before any response');
  for (const url of urls) pending.get(url)({ url, title: url, text: 'x'.repeat(50_000) });
  const result = await resultPromise;
  assert.equal(result.details.urls.length, 10);
  assert.ok(result.details.contentChars <= 50_000);
  assert.ok(result.content[0].text.length < 5_500, 'each page gets an equal share of the run budget');
});

test('a second fetch cannot exceed the run content budget', async () => {
  const tools = createWebTools(async (_path, init) => {
    const { url } = JSON.parse(init.body);
    return { url, title: 'Page', text: 'x'.repeat(50_000) };
  });
  const urls = Array.from({ length: 5 }, (_, index) => `https://example.com/${index}`);
  await tools[1].execute('first', { urls });
  await assert.rejects(tools[1].execute('second', { url: 'https://example.com/next' }), /正文预算已用完/);
});

test('page reads have no per-run page or call count cap', async () => {
  const tools = createWebTools(async (_path, init) => {
    const { url } = JSON.parse(init.body);
    return { url, title: 'Page', text: 'Evidence' };
  });
  await tools[1].execute('first', { urls: Array.from({ length: 10 }, (_, index) => `https://example.com/${index}`) });
  const next = await tools[1].execute('second', { url: 'https://example.com/next' });
  assert.deepEqual(next.details.urls, ['https://example.com/next']);
});

test('off-topic search snippets carry a warning rather than being treated as verified evidence', async () => {
  const tools = createWebTools(async () => ({ results: [
    { title: 'Welcome', url: 'https://example.com/', snippet: 'Homepage', rank: 1 },
  ] }));
  const result = await tools[0].execute('search1', { query: 'Python asyncio TaskGroup' });
  assert.match(result.content[0].text, /may be off-topic/);
});

const config = { id: 'test', name: 'Test model', protocol: 'completion', baseUrl: 'https://test.invalid/v1', modelId: 'test-model', contextWindow: 128000, maxOutput: 4096, requiresApiKey: true };
const history = [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '先前的回答', reasoning: 'do not resend hidden thinking' }, { id: 'u2', role: 'user', content: '继续', quote: '选中的历史回复\n第二段引用' }];

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

// Minimal pi-ai stream: content blocks are only in the final result. The callbacks run after
// the loop consumed the preceding event, so they observe the same timing as a live stream.
function assistantStream({ thinking = '', text = '', toolStart = false, afterThinking, afterText, afterToolStart, usage }) {
  const content = [
    ...(thinking ? [{ type: 'thinking', thinking }] : []),
    ...(text ? [{ type: 'text', text }] : []),
  ];
  const final = {
    role: 'assistant', content, api: 'completion', provider: 'test', model: 'test-model',
    usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: Date.now(),
  };
  const partial = { ...final, content: [] };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'start', partial };
      let index = 0;
      if (thinking) {
        yield { type: 'thinking_start', contentIndex: index, partial };
        afterThinking?.();
        yield { type: 'thinking_delta', contentIndex: index, delta: thinking, partial };
        yield { type: 'thinking_end', contentIndex: index, content: thinking, partial };
        index++;
      }
      if (text) {
        yield { type: 'text_start', contentIndex: index, partial };
        afterText?.();
        yield { type: 'text_delta', contentIndex: index, delta: text, partial };
        yield { type: 'text_end', contentIndex: index, content: text, partial };
        index++;
      }
      if (toolStart) {
        yield { type: 'toolcall_start', contentIndex: index, partial };
        afterToolStart?.();
        yield { type: 'toolcall_delta', contentIndex: index, delta: '{}', partial };
      }
      yield { type: 'done', reason: 'stop', message: final };
    },
    async result() { return final; },
  };
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
  assert.equal(runtime.getSnapshot().runs.a.conversationId, 'a');
  assert.equal(runtime.getSnapshot().runs.a.replyId, 'reply');
  assert.equal(runtime.start({ conversationId: 'a', replyId: 'other', config, apiKey: 'key', messages: history }), false, 'a conversation cannot start twice');
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
  assert.deepEqual(runtime.getSnapshot().runs, {});
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
  assert.equal(calls, 0, 'validation does not load provider modules');
  assert.equal(runtime.start(input), true);
  runtime.stop();
  loader.resolve({ createReplyRun() { assert.fail('a cancelled lazy load must not create a runner'); } });
  await finished.promise;
  assert.deepEqual(runtime.getSnapshot().runs, {});
  assert.equal(replies, 1);
  const disposedLoader = deferred();
  const disposed = createAgentRuntime({ loadRunner: () => disposedLoader.promise, onReply() { assert.fail('disposed runtimes must not publish replies'); } });
  assert.equal(disposed.start(input), true);
  disposed.dispose();
  assert.deepEqual(disposed.getSnapshot().runs, {});
  disposedLoader.reject(new Error('sensitive provider failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(disposed.start(input), false);
  // A single oversized message cannot be compacted away: it is the active request. The runtime
  // still validates the prepared history and reports the normal context error instead of
  // starting a request that the provider would reject.
  const overflowReply = deferred();
  const overflow = createAgentRuntime({
    loadRunner: async () => ({ createReplyRun() { assert.fail('an oversized single message cannot be compacted'); } }),
    onReply(_id, message) { if (message.status === 'error') overflowReply.resolve(message); },
  });
  assert.equal(overflow.start({ conversationId: 'big', replyId: 'big-reply', config: { ...config, contextWindow: 4200 },
    apiKey: 'key', messages: [{ id: 'u', role: 'user', content: 'x'.repeat(50_000) }] }), true);
  assert.match((await overflowReply.promise).error, /上下文/);
  overflow.dispose();
  runtime.dispose();
});

test('shared runtime runs different conversations concurrently and stops them by id', async () => {
  const completions = new Map([['a', deferred()], ['b', deferred()]]);
  const controls = new Map();
  const runtime = createAgentRuntime({
    onReply() {},
    loadRunner: async () => ({ createReplyRun(options) {
      const id = options.messages.at(-1).content;
      const control = { aborts: 0 };
      controls.set(id, control);
      return { abort() { control.aborts++; }, start: () => completions.get(id).promise };
    } }),
  });
  const request = (id) => ({ conversationId: id, replyId: `reply-${id}`, config, apiKey: 'key', messages: [{ id: `u-${id}`, role: 'user', content: id }] });
  async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(predicate(), 'expected runtime transition');
  }
  assert.equal(runtime.start(request('a')), true);
  assert.equal(runtime.start(request('b')), true);
  assert.deepEqual(Object.keys(runtime.getSnapshot().runs).sort(), ['a', 'b']);
  await until(() => controls.size === 2);
  runtime.stop('a');
  assert.equal(controls.get('a').aborts, 1);
  assert.equal(controls.get('b').aborts, 0, 'stopping one conversation leaves the other running');
  completions.get('a').resolve({ status: 'complete' });
  await until(() => !runtime.getSnapshot().runs.a);
  assert.deepEqual(Object.keys(runtime.getSnapshot().runs), ['b'], 'the other run survives the first one finishing');
  runtime.stop();
  assert.equal(controls.get('b').aborts, 1);
  completions.get('b').resolve({ status: 'complete' });
  await until(() => Object.keys(runtime.getSnapshot().runs).length === 0);
  runtime.dispose();
});

test('runtime silently compacts before the run and persists the summary on the next turn', async () => {
  const finishes = [deferred(), deferred()];
  const previous = [];
  const published = [];
  let request;
  let runs = 0;
  const runtime = createAgentRuntime({
    onReply(_id, message) { if (message.status === 'complete') finishes[runs - 1]?.resolve(); },
    onSummary(_id, summary) { published.push(summary); },
    loadRunner: async () => ({ createReplyRun(options) {
      request = options;
      return { abort() {}, start: async () => ({ status: 'complete' }) };
    } }),
    loadCompactor: async () => ({ prepareHistory: async (options) => {
      previous.push(options.previous);
      return {
        messages: [options.messages.at(-1)],
        systemPrompt: `${options.systemPrompt}\n\n<conversation_summary>\n早期摘要\n</conversation_summary>`,
        summary: { coveredUntilMessageId: options.messages[0].id, summary: '早期摘要' },
        compacted: true,
      };
    } }),
  });
  const messages = [
    { id: 'u1', role: 'user', content: 'old question' },
    { id: 'a1', role: 'assistant', content: 'old answer' },
    { id: 'u2', role: 'user', content: 'new question' },
  ];
  runs = 1;
  assert.equal(runtime.start({ conversationId: 'c', replyId: 'r1', config, apiKey: 'key', messages }), true);
  await finishes[0].promise;
  assert.deepEqual(request.messages.map((message) => message.id), ['u2']);
  assert.match(request.systemPrompt, /<conversation_summary>/);
  assert.equal(previous[0], undefined);
  assert.deepEqual(published, [{ coveredUntilMessageId: 'u1', summary: '早期摘要' }],
    'the summary is published once so the conversation can store it');
  assert.equal(runtime.getSnapshot().error, null, 'compaction stays silent');
  runs = 2;
  assert.equal(runtime.start({ conversationId: 'c', replyId: 'r2', config, apiKey: 'key', messages,
    contextSummary: published[0] }), true);
  await finishes[1].promise;
  assert.equal(previous[1].summary, '早期摘要', 'the stored summary is reused instead of recompacted');
  assert.equal(published.length, 1, 'an unchanged summary is not written again');
  runtime.dispose();
});

test('stopping during silent compaction never starts a runner or publishes a notice', async () => {
  const compaction = deferred();
  const finished = deferred();
  const runtime = createAgentRuntime({
    onReply(_id, message) { if (message.status === 'stopped') finished.resolve(message); },
    loadRunner: async () => ({ createReplyRun() { assert.fail('a stopped compaction must not create a runner'); } }),
    loadCompactor: async () => ({ prepareHistory: () => compaction.promise }),
  });
  assert.equal(runtime.start({ conversationId: 'c', replyId: 'r', config, apiKey: 'key', messages: history }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  runtime.stop('c');
  compaction.resolve({ messages: history, systemPrompt: '', compacted: false });
  const message = await finished.promise;
  assert.equal(message.status, 'stopped');
  assert.equal(runtime.getSnapshot().runs.c, undefined);
  assert.equal(runtime.getSnapshot().error, null);
  runtime.dispose();
});

test('steering text is wrapped in context and injected between turns of the same run', async () => {
  const context = buildContext([
    { id: 'u1', role: 'user', content: '原始问题' },
    { id: 's1', role: 'user', content: '请改成英文', steering: true },
    { id: 'a1', role: 'assistant', content: '回答' },
  ], config);
  assert.match(context[1].content, /<user_steering_message>/);
  assert.match(context[1].content, /请改成英文/);
  assert.ok(!JSON.stringify(context[0]).includes('<user_steering_message>'), 'normal user messages are untouched');

  const calls = [];
  const updates = [];
  const outcomes = [];
  let run;
  run = createReplyRun({
    config, apiKey: 'test-key',
    messages: [{ id: 'u1', role: 'user', content: '原始问题' }],
    onUpdate: (value) => updates.push(value),
    streamFn: (_model, requestContext) => {
      const call = calls.length;
      calls.push(requestContext);
      return assistantStream({
        thinking: call === 0 ? '先想一想' : '',
        text: call === 0 ? '先回答第一段' : '再补充第二段',
        usage: { input: 100, output: 20, cacheRead: call === 0 ? 500 : 800, cacheWrite: 0 },
        afterThinking: call === 0
          ? () => outcomes.push(run.steer({ id: 's1', role: 'user', content: '请改成英文', steering: true }))
          : undefined,
      });
    },
  });
  const result = await run.start();
  assert.equal(result.status, 'complete');
  assert.deepEqual(outcomes, ['steered'], 'thinking still accepts a supplement');
  assert.equal(calls.length, 2, 'the queued steering message starts another assistant turn');
  const second = JSON.stringify(calls[1].messages);
  assert.match(second, /<user_steering_message>/);
  assert.match(second, /请改成英文/);
  assert.equal(updates.at(-1).content, '先回答第一段\n\n再补充第二段', 'both turns stay in one visible reply');
  assert.equal(updates.at(-1).contextTokens.input, 900, 'context includes the latest cache read once');
  assert.equal(updates.at(-1).contextTokens.cacheRead, 800);
  assert.equal(updates.at(-1).contextTokens.cacheWrite, 0);
  assert.equal(updates.at(-1).contextTokens.output, 20);
  const reported = updates.map((value) => value.contextTokens).filter(Boolean);
  assert.ok(reported.every((value) => value.output > 0),
    'a new model call keeps the last provider report instead of emitting a zero-output estimate');
  assert.deepEqual(result.usage, { input: 200, output: 40, cacheRead: 1300, cacheWrite: 0 }, 'billing still sums both calls');
});

test('a provider that reports completion tokens without prompt counters still updates the reading', async () => {
  const updates = [];
  const run = createReplyRun({
    config, apiKey: 'test-key',
    messages: [{ id: 'u1', role: 'user', content: '你好' }],
    onUpdate: (value) => updates.push(value),
    streamFn: () => assistantStream({ text: '回答', usage: { input: 0, output: 7, cacheRead: 0, cacheWrite: 0 } }),
  });
  const result = await run.start();
  assert.equal(result.status, 'complete');
  const sample = updates.map((value) => value.contextTokens).filter(Boolean).at(-1);
  assert.equal(sample.output, 7);
  assert.equal(sample.input, 0);
});

test('a supplement is deferred once the answer text starts streaming', async () => {
  const calls = [];
  const updates = [];
  const outcomes = [];
  let run;
  run = createReplyRun({
    config, apiKey: 'test-key',
    messages: [{ id: 'u1', role: 'user', content: '原始问题' }],
    onUpdate: (value) => updates.push(value),
    streamFn: (_model, requestContext) => {
      calls.push(requestContext);
      return assistantStream({
        text: '最终回答',
        afterText: () => outcomes.push(run.steer({ id: 's1', role: 'user', content: '换个说法' })),
      });
    },
  });
  const result = await run.start();
  assert.equal(result.status, 'complete');
  assert.deepEqual(outcomes, ['deferred'], 'visible text closes the current run to steering');
  assert.equal(calls.length, 1, 'the deferred message does not start another turn in this run');
  assert.equal(updates.at(-1).content, '最终回答');
});

test('text that only introduces a tool call lets steering resume during the tool phase', async () => {
  const calls = [];
  const outcomes = [];
  let run;
  run = createReplyRun({
    config, apiKey: 'test-key',
    messages: [{ id: 'u1', role: 'user', content: '原始问题' }],
    onUpdate() {},
    streamFn: (_model, requestContext) => {
      const call = calls.length;
      calls.push(requestContext);
      return assistantStream({
        text: call === 0 ? '我先查一下' : '查到了',
        toolStart: call === 0,
        afterToolStart: call === 0 ? () => outcomes.push(run.steer({ id: 's1', role: 'user', content: '顺带查另一个' })) : undefined,
      });
    },
  });
  const result = await run.start();
  assert.equal(result.status, 'complete');
  assert.deepEqual(outcomes, ['steered'], 'the tool phase reopens steering');
  assert.equal(calls.length, 2);
  assert.match(JSON.stringify(calls[1].messages), /<user_steering_message>/);
});

test('a second assistant turn does not reopen steering after the answer began', async () => {
  const calls = [];
  const outcomes = [];
  let run;
  run = createReplyRun({
    config, apiKey: 'test-key',
    messages: [{ id: 'u1', role: 'user', content: '原始问题' }],
    onUpdate() {},
    streamFn: (_model, requestContext) => {
      const call = calls.length;
      calls.push(requestContext);
      return assistantStream({
        thinking: call === 0 ? '第一次思考' : '第二次思考',
        text: call === 0 ? '第一段正文' : '补充正文',
        afterThinking: call === 0 ? () => { run.steer({ id: 's1', role: 'user', content: '第一处补充' }); }
          : () => outcomes.push(run.steer({ id: 's2', role: 'user', content: '第二处补充' })),
      });
    },
  });
  const result = await run.start();
  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 2);
  assert.deepEqual(outcomes, ['deferred'], 'message_start must not reset the run-wide answer latch');
});

test('runtime buffers steering until the lazy runner loads and rejects it after the run', async () => {
  const loader = deferred();
  const completion = deferred();
  const steered = [];
  const runtime = createAgentRuntime({
    onReply() {},
    loadRunner: () => loader.promise,
  });
  const request = { conversationId: 'chat', replyId: 'reply', config, apiKey: 'key', messages: history };
  assert.equal(runtime.start(request), true);
  const message = { id: 's1', role: 'user', content: '补充' };
  assert.equal(runtime.steer('chat', message), 'steered', 'accepted while the runner is loading');
  assert.equal(runtime.steer('missing', message), false);
  loader.resolve({ createReplyRun() {
    return { steer(value) { steered.push(value); return true; }, abort() {}, start: () => completion.promise };
  } });
  for (let i = 0; i < 50 && steered.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(steered, [message]);
  completion.resolve({ status: 'complete' });
  for (let i = 0; i < 50 && Object.keys(runtime.getSnapshot().runs).length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(runtime.getSnapshot().runs, {});
  assert.equal(runtime.steer('chat', message), false, 'a finished run falls back to a normal send');
  runtime.dispose();
});

test('runtime forwards the runner deferred outcome unchanged', async () => {
  const loaded = deferred();
  const completion = deferred();
  const runtime = createAgentRuntime({
    onReply() {},
    loadRunner: async () => ({ createReplyRun() {
      loaded.resolve();
      return { steer: () => 'deferred', abort() {}, start: () => completion.promise };
    } }),
  });
  const request = { conversationId: 'chat', replyId: 'reply', config, apiKey: 'key', messages: history };
  assert.equal(runtime.start(request), true);
  await loaded.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(runtime.steer('chat', { id: 's1', role: 'user', content: '正文阶段' }), 'deferred');
  completion.resolve({ status: 'complete' });
  for (let i = 0; i < 50 && runtime.getSnapshot().runs.chat; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  runtime.dispose();
});

test('steering messages parse from storage and move back before the reply they interrupted', () => {
  const parsed = parseWorkspace({
    schemaVersion: 1,
    chat: {
      conversations: [{
        id: 'c1', title: 'c1', pinned: false, updatedAt: 1,
        messages: [
          { id: 'u1', role: 'user', content: '问题' },
          { id: 'a1', role: 'assistant', content: '回答', status: 'complete' },
          { id: 's1', role: 'user', content: '补充', steering: true },
          { id: 'u2', role: 'user', content: '正文开始后的下一轮' },
        ],
      }],
      activeId: 'c1', sidebarOpen: true,
    },
    appearance: { themeId: 'twitter', mode: 'system' },
  });
  const messages = parsed.data.chat.conversations[0].messages;
  assert.deepEqual(messages.map((message) => message.id), ['u1', 's1', 'a1', 'u2']);
  assert.equal(messages[1].steering, true);
  assert.ok(!('steering' in messages[2]), 'assistant messages never keep the flag');
  assert.ok(!('steering' in messages[3]), 'deferred messages stay behind the reply they followed');
});

test('stored rolling summaries survive parsing and malformed copies are dropped', () => {
  const summary = { coveredUntilMessageId: 'a1', summary: '早期要点' };
  const parsed = parseWorkspace({
    schemaVersion: 1,
    chat: {
      conversations: [
        {
          id: 'c1', title: 'c1', pinned: false, updatedAt: 1, contextSummary: summary,
          messages: [
            { id: 'u1', role: 'user', content: '问题' },
            { id: 'a1', role: 'assistant', content: '回答', status: 'complete' },
          ],
        },
        {
          id: 'c2', title: 'c2', pinned: false, updatedAt: 2,
          contextSummary: { coveredUntilMessageId: '', summary: '' }, messages: [],
        },
      ],
      activeId: 'c1', sidebarOpen: true,
    },
    appearance: { themeId: 'twitter', mode: 'system' },
  });
  const [valid, invalid] = parsed.data.chat.conversations;
  assert.deepEqual(valid.contextSummary, summary);
  assert.equal(invalid.contextSummary, undefined, 'invalid derived context is rebuilt on demand');
});

test('agent core has no UI, feature-module or browser dependencies', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const ts = (await import('typescript')).default;
  const directory = new URL('../ui/core/agent/', import.meta.url);
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
  for (const prompt of [buildSystemPrompt(defaultPersonalization), buildSystemPrompt({ ...defaultPersonalization, customInstructions: '  \n  ' })]) {
    assert.ok(prompt.startsWith(DEFAULT_SYSTEM_PROMPT));
    assert.ok(!prompt.includes('<current_context>'), 'the live clock stays out of the cacheable system prefix');
    assert.ok(!prompt.includes('<user_instructions>') && !prompt.includes('<user_profile>'));
  }
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

test('current context uses the local calendar date and timezone, including midnight across UTC', () => {
  const context = withCurrentContext('Base instructions', new Date('2026-10-24T16:05:06Z'), 'Asia/Shanghai');
  assert.match(context, /Current date: 2026-10-25/);
  assert.match(context, /Current local time: 00:05:06 \(UTC\+08:00\)/);
  assert.match(context, /Timezone: Asia\/Shanghai/);
  assert.ok(context.startsWith('Base instructions'));
  const next = withCurrentContext('Base', new Date('2026-10-25T16:05:06Z'), 'Asia/Shanghai');
  assert.match(next, /Current date: 2026-10-26/);
  assert.match(withCurrentContext('Base', new Date('2026-10-24T16:05:06Z'), 'invalid-zone'), /Timezone: UTC/);
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
/** Title generation is a separate, optional request; harness mocks answer it immediately so
    chat assertions keep seeing only reply traffic. */
function isTitleRequest(body) {
  return JSON.stringify(body?.messages ?? body?.system ?? '').includes('你负责为一段对话生成简短标题');
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
/** Emit the first SSE event immediately, then wait so a test can steer while text is visible. */
function gatedResponse(protocol, gate) {
  const source = events(protocol).map((event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
  const head = new TextEncoder().encode(source.slice(0, source.indexOf('\n\n') + 2));
  const tail = new TextEncoder().encode(source.slice(source.indexOf('\n\n') + 2));
  return new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(head);
      await gate.promise;
      controller.enqueue(tail);
      controller.close();
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
      assert.ok(!systemPayload.includes('<current_context>'), `${protocol} keeps the live clock out of the cached system prefix`);
      assert.match(payload, /<current_context>/);
      assert.match(payload, /Current date: \d{4}-\d{2}-\d{2}/);
      assert.match(payload, /Timezone:/);
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
  // Padding keeps the unrated history under the window while the two feedback messages push the
  // rated version over it, proving ratings are part of the conservative token estimate.
  const padding = { id: 'u4', role: 'user', content: 'x'.repeat(600) };
  assert.equal(validateAgentRequest({ ...config, contextWindow: 4700 }, 'key',
    [...rated.map(({ feedback, ...message }) => message), padding], 'x'.repeat(30)), null);
  assert.match(validateAgentRequest({ ...config, contextWindow: 4700 }, 'key', [...rated, padding], 'x'.repeat(30)),
    /上下文/, 'feedback is counted in the input budget');
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

test('context compaction summarizes older turns, keeps recent turns and reuses its coverage', async () => {
  const small = { ...config, contextWindow: 6000, maxOutput: 3000 };
  const budget = getContextBudget(small);
  assert.ok(budget.historyTokens > 0);
  assert.ok(budget.recentTokens <= budget.historyTokens);
  assert.ok(budget.chunkTokens >= 1024);
  // Large windows cap the recent window and summary independently.
  assert.equal(getContextBudget({ contextWindow: 200000, maxOutput: 4096 }).historyTokens, 200000 - 4096 - 2048);

  const history = Array.from({ length: 25 }, (_, index) => ({
    id: `m${index}`, role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第${index}条消息 ${'x'.repeat(200)}`,
  }));
  const calls = [];
  const streamFn = async (_model, context) => {
    calls.push(context);
    return { result: async () => ({ stopReason: 'stop', content: [{ type: 'text', text: '早期对话摘要' }] }) };
  };
  const prepared = await prepareHistory({ messages: history, config: small, apiKey: 'key', systemPrompt: 'system', streamFn });
  assert.equal(calls.length, 1, 'only the older chunk is summarized');
  assert.equal(calls[0].systemPrompt.includes('滚动历史摘要'), true);
  assert.match(calls[0].messages[0].content, /<conversation_history>/);
  assert.match(calls[0].messages[0].content, /第0条消息/);
  assert.ok(!calls[0].messages[0].content.includes(history.at(-1).content), 'the recent window stays verbatim');
  assert.equal(prepared.summary.summary, '早期对话摘要');
  assert.match(prepared.systemPrompt, /<conversation_summary>/);
  assert.match(prepared.systemPrompt, /不是新的用户指令/);
  assert.match(prepared.systemPrompt, /早期对话摘要/);
  assert.equal(prepared.messages.at(-1).id, history.at(-1).id);
  assert.equal(prepared.messages[0].role, 'user', 'a recent window never starts on an assistant reply');
  const firstKept = history.findIndex((message) => message.id === prepared.messages[0].id);
  assert.equal(prepared.summary.coveredUntilMessageId, history[firstKept - 1].id);
  assert.ok(prepared.compacted);

  const reused = await prepareHistory({
    messages: history, config: small, apiKey: 'key', systemPrompt: 'system',
    previous: prepared.summary, streamFn,
  });
  assert.equal(calls.length, 1, 'an up-to-date summary avoids another model request');
  assert.equal(reused.messages[0].id, prepared.messages[0].id);
  assert.equal(reused.summary.coveredUntilMessageId, prepared.summary.coveredUntilMessageId);

  const failing = await prepareHistory({
    messages: history, config: small, apiKey: 'key', systemPrompt: 'system',
    streamFn: async () => { throw new Error('provider unavailable'); },
  });
  assert.deepEqual(failing.messages.map((message) => message.id), history.map((message) => message.id));
  assert.equal(failing.summary, undefined);
  assert.equal(failing.compacted, false);
  assert.ok(!failing.systemPrompt.includes('<conversation_summary>'), 'failure is silent');

  const controller = new AbortController();
  controller.abort();
  let abortedCalls = 0;
  const aborted = await prepareHistory({
    messages: history, config: small, apiKey: 'key', systemPrompt: 'system', signal: controller.signal,
    streamFn: async () => { abortedCalls++; throw new Error('must not run'); },
  });
  assert.equal(abortedCalls, 0, 'a stopped run does not summarize');
  assert.deepEqual(aborted.messages.map((message) => message.id), history.map((message) => message.id));
});

test('recent context windows keep whole user turns and their steering supplements', () => {
  assert.equal(findRecentStart([
    { id: 'u1', role: 'user', content: 'one' },
    { id: 'a1', role: 'assistant', content: 'answer' },
    { id: 'u2', role: 'user', content: 'two' },
    { id: 'a2', role: 'assistant', content: 'answer two' },
  ], 0), 2, 'the window moves back to the user message');
  assert.equal(findRecentStart([
    { id: 'u1', role: 'user', content: 'one' },
    { id: 's1', role: 'user', content: 'supplement', steering: true },
    { id: 'a1', role: 'assistant', content: 'answer' },
  ], 0), 0, 'a steering message stays with the question it supplements');
});

test('interrupted replies retain their question and partial prose for follow-up requests', () => {
  const failed = [
    { id: 'u1', role: 'user', content: 'first question' },
    { id: 'a1', role: 'assistant', content: 'half an answer', status: 'error', error: '超时' },
  ];
  const context = buildContext(failed, config);
  assert.deepEqual(context.map(message => message.role), ['user', 'assistant']);
  assert.ok(JSON.stringify(context).includes('half an answer'));
  assert.ok(JSON.stringify(context).includes('新的独立请求'), 'an interrupted reply closes its turn for the next question');
  assert.ok(!JSON.stringify(context).includes('超时'), 'the error text is not part of the conversation');
  assert.ok(JSON.stringify(buildContext([...failed, { id: 'u2', role: 'user', content: '继续' }], config)).includes('half an answer'));
  assert.deepEqual(buildRetryHistory(failed).map(message => message.id), ['u1'], 'retry re-sends the original question');
  assert.deepEqual(withoutFailedReplies(failed), failed);
  assert.deepEqual(withoutFailedReplies([failed[0], { ...failed[1], content: '' }]), [failed[0]], 'only empty error placeholders are excluded');
  // A stopped turn is different: it holds text the user may want to continue from.
  const stopped = [failed[0], { id: 'a1', role: 'assistant', content: 'partial answer', status: 'stopped' }];
  assert.ok(JSON.stringify(buildContext(stopped, config)).includes('partial answer'));
  assert.deepEqual(buildRetryHistory(stopped).map(message => message.id), ['u1']);
  // Stopping before any prose (e.g. while thinking) must still close the old question, or the
  // next question and the abandoned one become consecutive user turns.
  const stoppedEmpty = [failed[0], { id: 'a1', role: 'assistant', content: '', status: 'stopped' }, { id: 'u2', role: 'user', content: 'new question' }];
  const stoppedEmptyContext = buildContext(stoppedEmpty, config);
  assert.deepEqual(stoppedEmptyContext.map(message => message.role), ['user', 'assistant', 'user'], 'an empty stopped reply still closes its turn');
  assert.match(JSON.stringify(stoppedEmptyContext), /终止/);
  assert.match(JSON.stringify(stoppedEmptyContext), /新的独立请求/);
});

test('sending after a failure preserves the question and partial reply on screen', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let chat;
  const initialState = {
    conversations: [{
      id: 'c1', title: 'c1', pinned: false, updatedAt: 0, errorReadAt: 1,
      messages: [
        { id: 'u1', role: 'user', content: 'question' },
        { id: 'a1', role: 'assistant', content: 'partial', status: 'error', error: '超时' },
      ],
    }],
    activeId: 'c1', sidebarOpen: true,
  };
  function Harness() { chat = useChat(); return null; }
  try {
    await act(async () => { root.render(createElement(ChatProvider, { initialState }, createElement(Harness))); });
    await act(async () => {
      chat.dispatch({ type: 'send', conversationId: 'c1', message: { id: 'u2', role: 'user', content: 'next' }, modelId: 'test' });
    });
    assert.deepEqual(chat.conversations[0].messages.map(message => message.id), ['u1', 'a1', 'u2'], 'sending never deletes the previous turn');
    assert.equal(chat.conversations[0].errorReadAt, undefined, 'the unread-error marker is cleared');
    const stale = structuredClone(chat.conversations[0]);
    await act(async () => {
      chat.dispatch({ type: 'reply', conversationId: 'c1', message: { id: 'a2', role: 'assistant', content: 'new live answer', status: 'streaming' } });
      chat.dispatch({ type: 'merge-sync', conversations: [{ ...stale, updatedAt: Date.now() + 10000 }] });
    });
    assert.equal(chat.conversations[0].messages.at(-1).content, 'new live answer', 'even a newer remote snapshot cannot overwrite a running stream');
    await act(async () => {
      chat.dispatch({ type: 'reply', conversationId: 'c1', message: { id: 'a2', role: 'assistant', content: 'finished answer', status: 'complete' } });
      chat.dispatch({ type: 'merge-sync', conversations: [{ ...stale, updatedAt: 0 }] });
    });
    assert.equal(chat.conversations[0].messages.at(-1).content, 'finished answer', 'a late old response cannot roll back the completed reply');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('a steering message is inserted before the streaming reply it supplements', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let chat;
  const initialState = {
    conversations: [{
      id: 'c1', title: 'c1', pinned: false, updatedAt: 0, completedReadAt: null,
      messages: [
        { id: 'u1', role: 'user', content: 'question' },
        { id: 'a1', role: 'assistant', content: 'streaming answer', status: 'streaming' },
      ],
    }],
    activeId: 'c1', sidebarOpen: true,
  };
  function Harness() { chat = useChat(); return null; }
  try {
    await act(async () => { root.render(createElement(ChatProvider, { initialState }, createElement(Harness))); });
    await act(async () => {
      chat.dispatch({ type: 'steer', conversationId: 'c1', replyId: 'a1', message: { id: 's1', role: 'user', content: '补充', steering: true } });
    });
    assert.deepEqual(chat.conversations[0].messages.map((message) => message.id), ['u1', 's1', 'a1']);
    assert.equal(chat.conversations[0].messages[1].steering, true);
    assert.equal(chat.activeId, 'c1', 'steering does not switch conversations');
    await act(async () => {
      chat.dispatch({ type: 'steer', conversationId: 'c1', message: { id: 's2', role: 'user', content: '稍后', steering: true } });
    });
    assert.deepEqual(chat.conversations[0].messages.map((message) => message.id), ['u1', 's1', 'a1', 's2'], 'without a live reply the message appends');
    await act(async () => {
      chat.dispatch({ type: 'append-user', conversationId: 'c1', message: { id: 'd1', role: 'user', content: '正文后的下一轮' } });
    });
    assert.deepEqual(chat.conversations[0].messages.map((message) => message.id), ['u1', 's1', 'a1', 's2', 'd1']);
    assert.ok(!('steering' in chat.conversations[0].messages.at(-1)), 'deferred messages carry no steering flag');
    assert.equal(chat.activeId, 'c1', 'appending a deferred message does not switch conversations');
    assert.equal(chat.conversations[0].completedReadAt, null, 'appending preserves unread markers');
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

test('ongoing streamed output resets the idle timeout while a separate total deadline stays bounded', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      let count = 0;
      const send = (delta, finish_reason = null) => controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      ));
      send({ role: 'assistant', content: '开始' });
      const interval = setInterval(() => {
        send({ content: '继续' });
        if (++count === 8) {
          clearInterval(interval);
          options.signal.removeEventListener('abort', abort);
          send({}, 'stop'); controller.close();
        }
      }, 25);
      const abort = () => { clearInterval(interval); controller.error(new DOMException('aborted', 'AbortError')); };
      options.signal.addEventListener('abort', abort, { once: true });
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await createReplyRun({ config, apiKey: 'key', messages: history, onUpdate() {}, timeoutMs: 100, maxDurationMs: 1500 }).start();
    assert.equal(result.status, 'complete', '200 ms of ongoing output must not hit a 100 ms idle timeout');
    const bounded = await createReplyRun({ config, apiKey: 'key', messages: history, onUpdate() {}, timeoutMs: 100, maxDurationMs: 90 }).start();
    assert.equal(bounded.status, 'error');
    assert.match(bounded.error, /本轮生成时间过长/);
  } finally { globalThis.fetch = original; }
});

test('real pi tool loop searches, reads evidence, then answers without losing process state', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const updates = [];
  const toolRequests = [];
  const frozenPrompt = DEFAULT_SYSTEM_PROMPT;
  const requestPrompts = [];
  const requestTimeContexts = [];
  const url = 'https://docs.python.org/3/library/asyncio-task.html';
  const tools = createWebTools(async (path, init) => {
    toolRequests.push(path);
    assert.ok(init.signal instanceof AbortSignal);
    return path.endsWith('/search') ? { results: [{ title: 'TaskGroup', url, snippet: 'Structured concurrency', rank: 1 }] }
      : { title: 'TaskGroup', url, text: 'TaskGroup waits for all tasks when the context manager exits.' };
  });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requestPrompts.push(body.messages.find((message) => message.role === 'system')?.content);
    requestTimeContexts.push(body.messages.filter((message) => typeof message.content === 'string' && message.content.includes('<current_context>')));
    const index = calls++;
    if (index === 2) assert.match(JSON.stringify(body.messages), /waits for all tasks/);
    const delta = index < 2 ? { role: 'assistant', content: index === 0 ? '先搜索官方文档。' : '页面已读，开始整理答案。',
      tool_calls: [{ index: 0, id: `tool-${index}`, type: 'function',
        function: { name: index === 0 ? 'web_search' : 'web_fetch', arguments: JSON.stringify(index === 0 ? { query: 'Python TaskGroup' } : { url }) } }] }
      : { role: 'assistant', content: `TaskGroup 等待组内任务完成。参考[文档](${url})。` };
    const chunks = [...(index === 0 || index === 2 ? [{ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: index === 0 ? '先检索官方文档。' : '读取完成，核对资料后作答。' }, finish_reason: null }] }] : []),
      { choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: index < 2 ? 'tool_calls' : 'stop' }] }];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await createReplyRun({ config, apiKey: 'key', messages: history, systemPrompt: frozenPrompt, tools, onUpdate: (update) => updates.push(update) }).start();
    assert.equal(result.status, 'complete');
    assert.equal(calls, 3);
    assert.deepEqual(requestPrompts, [frozenPrompt, frozenPrompt, frozenPrompt], 'the initial system prompt is reused unchanged across search and fetch continuations');
    assert.ok(!frozenPrompt.includes('<current_context>'), 'the live clock stays out of the cacheable system prefix');
    assert.ok(requestTimeContexts.every((items) => items.length === 1 && items[0].role === 'user'), 'each request appends one time-context user message');
    assert.deepEqual(toolRequests, ['/api/tools/search', '/api/tools/fetch']);
    assert.deepEqual(updates.at(-1).activities.map((activity) => activity.status), ['complete', 'complete']);
    assert.match(updates.at(-1).content, /参考\[文档\]/);
    assert.ok(!updates.at(-1).content.includes('先搜索官方文档'), 'the first transition is replaced, not accumulated');
    assert.ok(!updates.at(-1).content.includes('页面已读'), 'each transition text replaces the previous one');
    assert.ok(updates.some((update) => update.content.includes('先搜索官方文档')), 'the transition stays visible while it runs');
    assert.ok(updates.some((update) => update.activities.some((activity) => activity.status === 'running')));
    assert.deepEqual(updates.find((update) => update.activities.some((step) => step.kind === 'search' && step.status === 'running')).process.map((step) => step.kind), ['thinking', 'search']);
    assert.deepEqual(updates.find((update) => update.activities.some((step) => step.kind === 'fetch' && step.status === 'running')).process.map((step) => step.kind), ['thinking', 'search', 'fetch']);
    assert.deepEqual(updates.at(-1).process.map((step) => step.kind), ['thinking', 'search', 'fetch', 'thinking']);
    assert.equal(updates.at(-1).process[0].content, '先检索官方文档。');
    assert.equal(updates.at(-1).process[3].content, '读取完成，核对资料后作答。');
    assert.ok(updates.at(-1).process.every((step) => step.status === 'complete'));
  } finally { globalThis.fetch = original; }
});

test('two five-page fetch batches stay sequential without overlapping', async () => {
  const original = globalThis.fetch;
  let modelCalls = 0;
  let active = 0;
  let peak = 0;
  let pages = 0;
  const updates = [];
  const tools = createWebTools(async (_path, init) => {
    active++; peak = Math.max(peak, active); pages++;
    try {
      if (active > 5) throw new ApiError(429, 'rate_limited', 'Too many parallel pages');
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { url: JSON.parse(init.body).url, title: 'Page', text: 'Evidence' };
    } finally { active--; }
  });
  globalThis.fetch = async () => {
    const first = modelCalls++ === 0;
    const delta = first ? { role: 'assistant', tool_calls: [0, 1].map((batch) => ({
      index: batch, id: `batch-${batch}`, type: 'function', function: { name: 'web_fetch',
        arguments: JSON.stringify({ urls: [0, 1, 2, 3, 4].map((page) => `https://example.com/${batch}/${page}`) }) },
    })) } : { role: 'assistant', content: '已核对十个网页。' };
    return new Response([{ choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] }]
      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await createReplyRun({ config, apiKey: 'test', messages: history, tools, onUpdate: (update) => updates.push(update) }).start();
    assert.equal(result.status, 'complete');
    assert.equal(pages, 10);
    assert.equal(peak, 5, 'independent pages stay parallel but model batches cannot overlap');
    assert.ok(updates.at(-1).activities.every((activity) => activity.status === 'complete'));
  } finally { globalThis.fetch = original; }
});

test('a reasoning-only final response keeps its transcript but does not claim a completed answer', async () => {
  const original = globalThis.fetch;
  const updates = [];
  globalThis.fetch = async () => new Response([
    { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Only thinking' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await createReplyRun({ config, apiKey: 'test', messages: history, onUpdate: (update) => updates.push(update) }).start();
    assert.equal(result.status, 'error');
    assert.match(result.error, /仅返回了思考内容/);
    assert.equal(updates.at(-1).process[0].content, 'Only thinking');
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

test('generated titles are normalised, bounded and silently optional', async () => {
  assert.equal(normalizeConversationTitle('## “数据库迁移方案”\n换个说法'), '数据库迁移方案');
  assert.equal(normalizeConversationTitle('标题：异步任务重试'), '异步任务重试');
  assert.equal(normalizeConversationTitle('1. Title: Weekly plan'), 'Weekly plan');
  assert.equal(normalizeConversationTitle('普通标题。'), '普通标题。', 'a sentence-ending mark inside the title is kept');
  assert.equal(normalizeConversationTitle('   \n\t'), null);
  assert.equal(normalizeConversationTitle('标'.repeat(50)), '标'.repeat(16), 'CJK titles are bounded to 16 graphemes');
  assert.ok(normalizeConversationTitle('one two three four five six seven eight').split(' ').length <= 6);

  let captured;
  const success = async (model, context, options) => {
    captured = { model, context, options };
    return { result: async () => ({ role: 'assistant', content: [{ type: 'text', text: '  “AI 标题”  ' }], stopReason: 'stop' }) };
  };
  assert.equal(await generateConversationTitle({ config, apiKey: 'session-secret', content: '  first message  ', streamFn: success }), 'AI 标题');
  assert.equal(captured.model.id, config.modelId);
  assert.ok(captured.context.systemPrompt.startsWith(TITLE_SYSTEM_PROMPT));
  assert.match(captured.context.systemPrompt, /<current_context>/);
  assert.equal(captured.context.messages[0].content, 'first message');
  assert.equal(captured.options.apiKey, 'session-secret');
  assert.equal(captured.options.maxTokens, 512, 'leave room for low reasoning and a short title');
  assert.equal(captured.options.reasoning, 'low');
  assert.equal(captured.model.reasoning, true);
  assert.ok(captured.options.signal instanceof AbortSignal);

  let calls = 0;
  const counted = async () => { calls++; return { result: async () => ({ content: [], stopReason: 'stop' }) }; };
  assert.equal(await generateConversationTitle({ config, apiKey: '', content: 'hi', streamFn: counted }), null, 'a missing key fails before the request');
  assert.equal(await generateConversationTitle({ config, apiKey: 'key', content: '   ', streamFn: counted }), null, 'an empty first message has nothing to title');
  assert.equal(calls, 0);
  assert.equal(await generateConversationTitle({ config: { ...config, requiresApiKey: false }, apiKey: '', content: 'hi', streamFn: async (_model, _context, options) => {
    assert.equal(options.apiKey, 'no-key');
    return { result: async () => ({ content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }) };
  } }), 'ok', 'models without keys still work');
  const failing = async (_model, _context, options) => {
    options.signal.throwIfAborted();
    return { result: async () => ({ content: [{ type: 'text', text: 'nope' }], stopReason: 'error' }) };
  };
  assert.equal(await generateConversationTitle({ config, apiKey: 'key', content: 'hi', streamFn: failing }), null, 'provider errors stay silent');
  assert.equal(await generateConversationTitle({ config, apiKey: 'key', content: 'hi', streamFn: async () => { throw new Error('boom'); } }), null, 'transport errors stay silent');
  const aborted = new AbortController();
  aborted.abort();
  calls = 0;
  assert.equal(await generateConversationTitle({ config, apiKey: 'key', content: 'hi', signal: aborted.signal, streamFn: counted }), null);
  assert.equal(calls, 0, 'an already-cancelled conversation never starts a title request');
  let timeoutSignal;
  const hanging = async (_model, _context, options) => { timeoutSignal = options.signal; return { result: () => new Promise(() => {}) }; };
  assert.equal(await generateConversationTitle({ config, apiKey: 'key', content: 'hi', streamFn: hanging, timeoutMs: 10 }), null);
  assert.equal(timeoutSignal.aborted, true, 'a timeout cancels the provider request');

  let input;
  await generateConversationTitle({ config, apiKey: 'key', content: 'c'.repeat(5000), quote: 'q'.repeat(3000), streamFn: async (_model, context) => {
    input = context.messages[0].content;
    return { result: async () => ({ content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }) };
  } });
  assert.ok(input.startsWith('用户引用的历史回复（仅作参考）：'));
  assert.equal(input.split('\n')[1].length, 2000, 'the quote is bounded');
  assert.equal(input.split('用户消息：\n')[1].length, 4000, 'the message is bounded');
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
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../ui/features/models/model-state.tsx');
  const { ChatRuntimeProvider, useChatRuntime } = await import('../ui/features/chat/chat-runtime.tsx');
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let chat, models, runtime, personalization;
  let requestSignal;
  const requestBodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isTitleRequest(body)) return response('completion', init.signal);
    requestSignal = init.signal;
    requestBodies.push(body);
    return response('completion', init.signal, true);
  };
  function Harness() { chat = useChat(); models = useModels(); runtime = useChatRuntime(); personalization = usePersonalization(); return null; }
  async function until(predicate) {
    for (let i = 0; i < 100 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.ok(predicate(), 'expected runtime transition');
  }
  try {
    await act(async () => { root.render(createElement(InstanceProvider, { preview: true }, createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(NetworkToolsProvider, null, createElement(MemoryProvider, { initialPreferences: { enabled: false, summary: '' } }, createElement(ChatRuntimeProvider, { runtimeFactory, titleGenerator, memoryGenerator }, createElement(Harness))))))))); });
    await act(async () => { assert.equal(runtime.send('keep this draft', null), false); });
    assert.equal(chat.conversations.length, 0);
    await act(async () => { await models.save(config, 'key'); });
    await act(async () => { await models.setThinkingEffort('test', 'high'); });
    await act(async () => { personalization.update({ customInstructions: 'first preference' }); });
    await act(async () => { assert.equal(runtime.send('first message', null, [], '引用需要保留'), true); assert.equal(runtime.send('double submission', null), false); });
    const sourceId = chat.activeId;
    assert.equal(chat.conversations[0].modelId, 'test', 'a new conversation binds to the model that answered it');
    assert.equal(chat.conversations[0].messages[0].quote, '引用需要保留');
    await until(() => requestSignal && chat.conversations[0].messages.length === 2);
    assert.equal(requestBodies[0].reasoning_effort, 'high');
    assert.ok(JSON.stringify(requestBodies[0]).includes('first preference'));
    await act(async () => { personalization.update({ customInstructions: 'updated preference' }); });
    await act(async () => { chat.dispatch({ type: 'select', id: null }); });
    assert.equal(chat.activeId, null);
    assert.equal(models.selectedId, 'test', 'a new conversation keeps the most recently used model');
    await act(async () => { runtime.stop(); });
    await until(() => Object.keys(runtime.runs).length === 0);
    assert.equal(chat.activeId, null, 'reply updates must not navigate back to their source');
    assert.equal(chat.conversations[0].messages[1].content, '你好');
    assert.equal(chat.conversations[0].messages[1].status, 'stopped');
    await act(async () => { chat.dispatch({ type: 'feedback', conversationId: sourceId, messageId: chat.conversations[0].messages[1].id, feedback: 'bad' }); });
    assert.equal(requestBodies.length, 1, 'rating an answer alone does not start a request');
    requestSignal = undefined;
    await act(async () => { runtime.retry(sourceId); });
    await until(() => requestSignal && !!runtime.runs[sourceId]);
    assert.equal(requestBodies[1].reasoning_effort, 'high', 'retry resolves the effort of the conversation model');
    assert.ok(JSON.stringify(requestBodies[1]).includes('updated preference'), 'retry reads the latest personalization');
    assert.ok(JSON.stringify(requestBodies[1]).includes('引用需要保留'), 'retry includes the original quote');
    assert.ok(JSON.stringify(requestBodies[1]).includes('踩（没有帮助）'), 'retry includes feedback on the version being replaced');
    await act(async () => { chat.dispatch({ type: 'delete', id: sourceId }); });
    await until(() => Object.keys(runtime.runs).length === 0);
    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(chat.conversations, []);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('background replies in separate conversations run together, stay unread and raise one card', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../ui/features/models/model-state.tsx');
  const { ChatRuntimeProvider, useChatRuntime } = await import('../ui/features/chat/chat-runtime.tsx');
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const gates = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isTitleRequest(body)) return response('completion', init.signal);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    return response('completion', init.signal);
  };
  let chat, models, runtime;
  function Harness() { chat = useChat(); models = useModels(); runtime = useChatRuntime(); return null; }
  async function until(predicate) {
    for (let i = 0; i < 200 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.ok(predicate(), 'expected runtime transition');
  }
  const conversation = (id) => chat.conversations.find((item) => item.id === id);
  try {
    await act(async () => { root.render(createElement(InstanceProvider, { preview: true }, createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(NetworkToolsProvider, null, createElement(MemoryProvider, { initialPreferences: { enabled: false, summary: '' } }, createElement(ChatRuntimeProvider, { runtimeFactory, titleGenerator, memoryGenerator }, createElement(Harness))))))))); });
    await act(async () => { await models.save(config, 'key'); });

    await act(async () => { assert.equal(runtime.send('first', null), true); });
    const firstId = chat.activeId;
    await act(async () => { chat.dispatch({ type: 'select', id: null }); });
    await act(async () => { assert.equal(runtime.send('second', null), true); });
    const secondId = chat.activeId;
    await until(() => gates.length === 2);
    assert.ok(runtime.isRunning(firstId) && runtime.isRunning(secondId), 'both conversations generate at once');
    assert.equal(Object.keys(runtime.runs).length, 2);
    assert.equal(runtime.isAnyRunning, true);

    await act(async () => { gates[0].resolve(); });
    await until(() => conversation(firstId)?.messages.at(-1)?.status === 'complete');
    assert.equal(conversation(firstId).completedReadAt, null, 'a background completion stays unread');
    assert.equal(runtime.notifications.length, 1);
    assert.equal(runtime.notifications[0].conversationId, firstId);
    assert.equal(runtime.notifications[0].preview, '你好，世界');
    assert.ok(runtime.isRunning(secondId), 'the first completion does not disturb the other run');

    await act(async () => { gates[1].resolve(); });
    await until(() => conversation(secondId)?.messages.at(-1)?.status === 'complete');
    assert.equal(conversation(secondId).completedReadAt, undefined, 'the visible conversation is already read');
    assert.equal(runtime.notifications.length, 1, 'only the conversation away from the reader raises a card');

    await act(async () => { chat.dispatch({ type: 'select', id: firstId }); });
    assert.equal(conversation(firstId).completedReadAt, undefined, 'opening the conversation marks it read');
    await until(() => runtime.notifications.length === 0);
    assert.equal(runtime.notifications.length, 0, 'opening the conversation dismisses its card');

    // Full-page routes keep activeId but unmount the chat screen; completion is still unread.
    await act(async () => { chat.dispatch({ type: 'select', id: secondId }); });
    await act(async () => { chat.dispatch({ type: 'visible', value: false }); });
    await act(async () => { assert.equal(runtime.send('third', secondId), true); });
    await until(() => gates.length === 3);
    await act(async () => { gates[2].resolve(); });
    await until(() => conversation(secondId)?.messages.at(-1)?.status === 'complete' && conversation(secondId).messages.length === 4);
    assert.equal(conversation(secondId).completedReadAt, null, 'a completion while settings is open stays unread');
    assert.equal(runtime.notifications.length, 1);
    assert.equal(Object.keys(runtime.runs).length, 0);

    // Coming back keeps activeId unchanged, but the reply is now on screen.
    await act(async () => { chat.dispatch({ type: 'visible', value: true }); });
    assert.equal(conversation(secondId).completedReadAt, undefined, 'returning to the open conversation marks it read');
    await until(() => runtime.notifications.length === 0);
    assert.equal(runtime.notifications.length, 0);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('a supplement sent after the answer text starts becomes a separate follow-up turn', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../ui/features/models/model-state.tsx');
  const { ChatRuntimeProvider, useChatRuntime } = await import('../ui/features/chat/chat-runtime.tsx');
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const gates = [];
  const requestBodies = [];
  let replyCalls = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isTitleRequest(body)) return response('completion', init.signal);
    requestBodies.push(body);
    replyCalls++;
    if (replyCalls === 1) {
      const gate = deferred();
      gates.push(gate);
      return gatedResponse('completion', gate);
    }
    return response('completion', init.signal);
  };
  let chat, models, runtime;
  function Harness() { chat = useChat(); models = useModels(); runtime = useChatRuntime(); return null; }
  async function until(predicate) {
    for (let i = 0; i < 200 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.ok(predicate(), 'expected runtime transition');
  }
  const conversation = (id) => chat.conversations.find((item) => item.id === id);
  try {
    await act(async () => { root.render(createElement(InstanceProvider, { preview: true }, createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(NetworkToolsProvider, null, createElement(MemoryProvider, { initialPreferences: { enabled: false, summary: '' } }, createElement(ChatRuntimeProvider, { runtimeFactory, titleGenerator, memoryGenerator }, createElement(Harness))))))))); });
    await act(async () => { await models.save(config, 'key'); });

    await act(async () => { assert.equal(runtime.send('first question', null), true); });
    const id = chat.activeId;
    await until(() => replyCalls === 1 && conversation(id)?.messages.some((message) => message.role === 'assistant' && message.content.includes('你好')));

    let outcome;
    await act(async () => { outcome = runtime.steer('补充一下', id); });
    assert.equal(outcome, 'deferred', 'visible answer text defers the supplement');
    assert.equal(runtime.pendingMessages(id).length, 1, 'the supplement is shown from memory');
    assert.ok(!conversation(id).messages.some((message) => message.content === '补充一下'), 'it is not saved before the run ends');
    assert.equal(replyCalls, 1, 'no second request starts while the first reply is still streaming');

    await act(async () => { gates[0].resolve(); });
    await until(() => replyCalls === 2);
    await until(() => conversation(id)?.messages.length === 4 && conversation(id).messages.at(-1).status !== 'streaming');
    const messages = conversation(id).messages;
    assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant'],
      'the supplement moves below the finished reply and gets its own answer');
    assert.equal(messages[2].content, '补充一下');
    assert.ok(!('steering' in messages[2]), 'deferred messages persist without the steering flag');
    assert.equal(runtime.pendingMessages(id).length, 0, 'the queue is drained after starting the next turn');
    const nextRequest = JSON.stringify(requestBodies[1]);
    assert.ok(nextRequest.includes('补充一下'), 'the next request carries the supplement');
    assert.ok(!nextRequest.includes('<user_steering_message>'), 'it is a normal user turn, not an injected steer');
  } finally {
    gates.forEach((gate) => gate.resolve());
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('conversation titles are only auto-replaced while unattended, and renames stay manual', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let chat;
  function Harness() { chat = useChat(); return null; }
  const conversation = () => chat.conversations.find((item) => item.id === 'c1');
  try {
    await act(async () => { root.render(createElement(ChatProvider, null, createElement(Harness))); });
    await act(async () => { chat.dispatch({ type: 'send', conversationId: 'c1', message: { id: 'u1', role: 'user', content: '  如何配置  ' }, modelId: 'm' }); });
    assert.equal(conversation().title, '如何配置', 'the first message is the fallback title');
    assert.equal(conversation().titleSource, 'auto');
    await act(async () => { chat.dispatch({ type: 'auto-title', conversationId: 'c1', title: '配置指南', from: '如何配置' }); });
    assert.equal(conversation().title, '配置指南');
    assert.equal(conversation().titleSource, 'ai');
    await act(async () => { chat.dispatch({ type: 'auto-title', conversationId: 'c1', title: '迟到', from: '如何配置' }); });
    assert.equal(conversation().title, '配置指南', 'a title computed from an older fallback is dropped');
    await act(async () => { chat.dispatch({ type: 'rename', id: 'c1', title: '我的标题' }); });
    assert.equal(conversation().titleSource, 'manual');
    await act(async () => { chat.dispatch({ type: 'auto-title', conversationId: 'c1', title: '迟到的 AI 标题', from: '我的标题' }); });
    assert.equal(conversation().title, '我的标题', 'manual renames always win');
    await act(async () => { chat.dispatch({ type: 'send', conversationId: 'c1', message: { id: 'u2', role: 'user', content: '下一条' }, modelId: 'm' }); });
    assert.equal(conversation().title, '我的标题', 'later messages never retitle an existing conversation');
    await act(async () => { chat.dispatch({ type: 'reply', conversationId: 'c1', message: { id: 'a1', role: 'assistant', content: '答复', status: 'complete' } }); });
    await act(async () => { chat.dispatch({ type: 'fork', conversationId: 'c1', messageId: 'a1', forkId: 'fork', updatedAt: 1 }); });
    const fork = chat.conversations.find((item) => item.id === 'fork');
    assert.equal(fork.titleSource, 'manual', 'a branch keeps its custom title');
    await act(async () => { chat.dispatch({ type: 'auto-title', conversationId: 'fork', title: '替换', from: fork.title }); });
    assert.equal(chat.conversations.find((item) => item.id === 'fork').title, fork.title);
    await act(async () => { chat.dispatch({ type: 'auto-title', conversationId: 'c1', title: '   ', from: '我的标题' }); });
    assert.equal(conversation().title, '我的标题', 'an empty generated title is ignored');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('AI titles run beside the first reply, retry after a failed turn, and never override a rename', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../ui/features/models/model-state.tsx');
  const { ChatRuntimeProvider, useChatRuntime } = await import('../ui/features/chat/chat-runtime.tsx');
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let fail = true;
  let holdTitle = false;
  let releaseTitle = null;
  const titleRequests = [];
  const titleSignals = [];
  const errorResponse = () => new Response(JSON.stringify({ error: { message: 'unavailable' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (isTitleRequest(body)) {
      titleRequests.push(body);
      titleSignals.push(init.signal);
      if (fail) return errorResponse();
      if (holdTitle) await new Promise((resolve) => { releaseTitle = resolve; });
      return response('completion', init.signal);
    }
    if (fail) return errorResponse();
    return response('completion', init.signal);
  };
  let chat, models, runtime;
  function Harness() { chat = useChat(); models = useModels(); runtime = useChatRuntime(); return null; }
  async function until(predicate, label) {
    for (let i = 0; i < 200 && !predicate(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    assert.ok(predicate(), label);
  }
  const conversation = (id) => chat.conversations.find((item) => item.id === id);
  try {
    await act(async () => { root.render(createElement(InstanceProvider, { preview: true }, createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(NetworkToolsProvider, null, createElement(MemoryProvider, { initialPreferences: { enabled: false, summary: '' } }, createElement(ChatRuntimeProvider, { runtimeFactory, titleGenerator, memoryGenerator }, createElement(Harness))))))))); });
    await act(async () => { await models.save(config, 'key'); });

    // The first turn and its title both fail: the truncated first message stays.
    await act(async () => { assert.equal(runtime.send('first message', null), true); });
    const firstId = chat.activeId;
    await until(() => conversation(firstId)?.messages.at(-1)?.status === 'error' && titleRequests.length === 1, 'both requests settle');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.equal(conversation(firstId).title, 'first message');
    assert.equal(conversation(firstId).titleSource, 'auto');
    assert.equal(titleRequests[0].model, 'test-model', 'without a title model the conversation model is used');
    assert.ok(!conversation(firstId).messages.some((message) => message.role === 'assistant' && message.id === 'title'), 'a title never becomes a message');

    // A later successful reply retries the title once and applies it.
    fail = false;
    await act(async () => { runtime.retry(firstId); });
    await until(() => conversation(firstId)?.messages.at(-1)?.status === 'complete' && conversation(firstId).titleSource === 'ai', 'the retried reply produces a title');
    assert.equal(conversation(firstId).title, '你好，世界');
    assert.equal(titleRequests.length, 2);

    // A rename made while a title request is in flight wins when the result lands.
    holdTitle = true;
    await act(async () => { assert.equal(runtime.send('second conversation', null), true); });
    const secondId = chat.activeId;
    await until(() => titleRequests.length === 3, 'the second conversation starts a title request');
    await act(async () => { chat.dispatch({ type: 'rename', id: secondId, title: '手动标题' }); });
    releaseTitle();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
    assert.equal(conversation(secondId).title, '手动标题');
    assert.equal(conversation(secondId).titleSource, 'manual');

    // Deleting a conversation aborts only its own title request.
    holdTitle = true;
    releaseTitle = null;
    await act(async () => { assert.equal(runtime.send('third conversation', null), true); });
    const thirdId = chat.activeId;
    await until(() => titleRequests.length === 4, 'the third conversation starts a title request');
    await act(async () => { chat.dispatch({ type: 'delete', id: thirdId }); });
    await until(() => titleSignals[3].aborted === true, 'deleting a conversation aborts its title request');
    releaseTitle();

    // An explicitly configured title model takes precedence over the conversation model.
    holdTitle = false;
    await act(async () => { await models.save({ ...config, id: 'title-model', modelId: 'title-model-id', name: 'Title model' }, 'title-key'); });
    await act(async () => { await models.setTitleModelId('title-model'); });
    await act(async () => { assert.equal(runtime.send('fourth conversation', null), true); });
    const fourthId = chat.activeId;
    await until(() => conversation(fourthId)?.titleSource === 'ai', 'the explicit title model generates a title');
    assert.equal(titleRequests.at(-1).model, 'title-model-id');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('conversation URLs override saved selection, follow history changes and reject missing or deleted IDs', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const { useConversationRouteState } = await import('../ui/features/chat/conversation-route-state.ts');
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const initialState = { conversations: ['a', 'b'].map(id => ({ id, title: id, pinned: false, updatedAt: 0, messages: [] })), activeId: 'a', sidebarOpen: true };
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
  const { FileTypeIcon } = await import('../ui/features/chat/components/file-type-icon.tsx');
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

test('model brand icons recognise spaced GPT names instead of falling back', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ModelIcon } = await import('../ui/features/chat/components/model-icon.tsx');
  const Openai = (await import('@thesvg/react/openai')).default;
  const brand = renderToStaticMarkup(createElement(Openai, { width: 16, height: 16, 'aria-hidden': true, focusable: false, variant: 'light' }));
  const render = (props) => renderToStaticMarkup(createElement(ModelIcon, { ...props, size: 16 }));
  assert.ok(render({ modelId: 'gpt astra' }).includes(brand), 'a space-separated GPT name uses the OpenAI mark');
  assert.ok(render({ modelId: 'gpt4o' }).includes(brand), 'a bare gpt prefix with a digit is recognised');
  assert.ok(render({ modelId: 'gpt-4o' }).includes(brand));
  assert.ok(render({ name: 'GPT Astra', providerName: 'Some gateway' }).includes(brand));
  assert.ok(render({ name: 'Astra', providerName: 'OpenAI' }).includes(brand), 'the provider name is a fallback');
  assert.ok(!render({ modelId: 'unknown-model' }).includes(brand), 'unknown models keep the generic fallback');
});

test('composer reports validation in a compact chat notice without blocking input or losing drafts', async () => {
  const { createElement, act, useState } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider } = await import('../ui/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../ui/features/models/model-state.tsx');
  const { ChatRuntimeProvider } = await import('../ui/features/chat/chat-runtime.tsx');
  const { Composer } = await import('../ui/features/chat/components/composer.tsx');
  const { ChatNotice } = await import('../ui/features/chat/components/chat-notice.tsx');
  const { conversationHref } = await import('../ui/features/chat/conversation-href.ts');
  assert.equal(conversationHref(null), '/');
  assert.equal(conversationHref('a/b'), '/c/a%2Fb');
  assert.equal(conversationHref('demo', true), '/mock/chat/c/demo');
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.HTMLElement = window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  // Documents need the `files` capability and finish uploading before they can be sent,
  // so this test signs in and answers the upload endpoint.
  globalThis.fetch = async (path) => {
    if (path === '/api/features') {
      return Response.json({ features: [{ id: 'files' }] });
    }
    return Response.json({ id: 'uploaded-file', filename: 'notes.pdf', size: 8, contentType: 'application/pdf', createdAt: 1 });
  };
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  const root = createRoot(document.getElementById('root'));
  let models;
  let sent = 0;
  function Harness() {
    models = useModels();
    const [notice, setNotice] = useState(null);
    return createElement('div', { className: 'chat-screen' },
      createElement(ChatNotice, { items: notice ? [{ id: 'composer-notice', message: notice }] : [], onClose: () => setNotice(null) }),
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
    await act(async () => { root.render(createElement(InstanceProvider, { preview: false }, createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(NetworkToolsProvider, null, createElement(MemoryProvider, { initialPreferences: { enabled: false, summary: '' } }, createElement(ChatRuntimeProvider, { runtimeFactory, titleGenerator, memoryGenerator }, createElement(Harness))))))))); });
    // Wait for the signed-in account's `files` capability: the picker drops its
    // image-only filter and document uploads become available.
    for (let attempt = 0; attempt < 100 && document.querySelector('input[type="file"]')?.hasAttribute('accept'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.equal(document.querySelector('.composer-attach').disabled, false);
    assert.equal(document.querySelector('input[type="file"]').hasAttribute('accept'), false);
    await choose(new File(['document'], 'notes.pdf', { type: 'application/pdf' }));
    for (let attempt = 0; attempt < 100 && document.querySelector('.attachment-meta')?.textContent === '上传中…'; attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    assert.equal(document.querySelector('.composer-attachment').getAttribute('title'), 'notes.pdf');
    assert.equal(document.querySelector('.composer-attachment .file-type-icon').getAttribute('data-file-icon'), 'pdf');
    assert.equal(document.querySelector('.attachment-name').textContent, 'notes.pdf');
    assert.equal(document.querySelector('.attachment-meta').textContent, '8 B');
    assert.equal(document.querySelector('dialog'), null, 'selection does not validate files');
    await submit();
    assert.match(document.querySelector('.chat-notice').textContent, /添加并选择模型/);
    await closePopup();
    await act(async () => { await models.save(config, 'key'); });
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
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.HTMLElement = previous.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('the process header stays running after thinking ends and measures through answer completion', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { parseHTML } = await import('linkedom');
  const { ChatProvider, useChat } = await import('../ui/features/chat/chat-state.tsx');
  const { ModelProvider, useModels } = await import('../ui/features/models/model-state.tsx');
  const { ChatRuntimeProvider, useChatRuntime } = await import('../ui/features/chat/chat-runtime.tsx');
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  // The header must keep running throughout this quiet gap and include it in the final time.
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
    await act(async () => { root.render(createElement(InstanceProvider, { preview: true }, createElement(PersonalizationProvider, null, createElement(ChatProvider, null, createElement(ModelProvider, { preview: true }, createElement(NetworkToolsProvider, null, createElement(MemoryProvider, { initialPreferences: { enabled: false, summary: '' } }, createElement(ChatRuntimeProvider, { runtimeFactory, titleGenerator, memoryGenerator }, createElement(Harness))))))))); });
    await act(async () => { await models.save({ ...config, protocol: 'message', baseUrl: 'https://test.invalid' }, 'key'); });
    await act(async () => { assert.equal(runtime.send('问题', null), true); });
    await until(() => chat.conversations[0]?.messages[1]?.reasoningActive === false && !!chat.conversations[0]?.messages[1]?.reasoning);
    const thinkingFinished = chat.conversations[0].messages[1];
    assert.ok(Object.keys(runtime.runs).length > 0, 'the request is still running after thinking_end');
    assert.equal(thinkingFinished.status, 'streaming');
    assert.equal(thinkingFinished.content, '', 'thinking ends before the first answer token');
    const { getReasoningState, ReasoningBlock } = await import('../ui/features/chat/components/reasoning-block.tsx');
    const { renderToStaticMarkup } = await import('react-dom/server');
    assert.equal(getReasoningState(thinkingFinished), 'running');
    const markup = renderToStaticMarkup(createElement(ReasoningBlock, { reasoning: thinkingFinished.reasoning, state: getReasoningState(thinkingFinished), elapsedMs: thinkingFinished.thinkingMs }));
    assert.ok(markup.includes('思考过程'));
    assert.ok(markup.includes('is-running'), 'the whole process stays active while the answer is pending');
    assert.equal(getReasoningState({ status: 'streaming', content: '正文', reasoningActive: false }), 'running');
    assert.equal(getReasoningState({ status: 'streaming', content: '', reasoningActive: true }), 'running');
    assert.equal(getReasoningState({ status: 'streaming', content: '', reasoningActive: false }), 'running', 'an empty message_start is still waiting, not completed thinking');
    assert.equal(getReasoningState({ status: 'stopped', content: '' }), 'stopped');
    assert.equal(getReasoningState({ status: 'error', content: '' }), 'error');
    await until(() => Object.keys(runtime.runs).length === 0);
    const reply = chat.conversations[0].messages[1];
    assert.equal(reply.content, '答案');
    assert.equal(reply.reasoning, '先想一下');
    assert.ok(Number.isFinite(reply.thinkingMs), 'a reply with reasoning carries a measured duration');
    assert.ok(reply.thinkingMs >= gapAfterThinkingMs,
      `total duration includes the gap before the answer, measured ${reply.thinkingMs}ms`);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.fetch = previous.fetch; globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
