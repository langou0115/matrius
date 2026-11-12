import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { MessageContent } from '../src/features/chat/components/message-content.tsx';
import { CodeBlock } from '../src/features/chat/components/code-block.tsx';
import { ModelIcon } from '../src/features/chat/components/model-icon.tsx';
import { normalizeMarkdown } from '../src/features/chat/markdown/normalize-markdown.ts';
import { highlightCode } from '../src/features/chat/markdown/highlight-code.ts';
import { createDemoWorkspace } from '../dev/fixtures/chat-workspace.ts';
import { ReasoningBlock } from '../src/features/chat/components/reasoning-block.tsx';
import { groupResearchSteps } from '../src/features/chat/components/research-group.tsx';
import { ResearchPanel } from '../src/features/chat/components/research-panel.tsx';
import { ReplyStatus } from '../src/features/chat/components/reply-status.tsx';

test('collapsed thinking stays lightweight and the waiting header remains clickable', () => {
  const reasoning = renderToStaticMarkup(createElement(ReasoningBlock, { state: 'running', reasoning: '**Long thinking transcript**' }));
  assert.ok(!reasoning.includes('Long thinking transcript'), 'collapsed transcripts do not repeatedly parse/render streamed Markdown');
  assert.ok(reasoning.includes('aria-expanded="false"'));
  const waiting = renderToStaticMarkup(createElement(ReasoningBlock, { state: 'running' }));
  assert.ok(waiting.includes('<button'), 'the same thinking header is clickable before the first token');
  assert.ok(waiting.includes('aria-expanded="false"'));

});

test('the live thinking segment renders as plain text until it stops streaming', () => {
  const step = { id: 'thinking:1:0', kind: 'thinking', content: '**流式思考**', status: 'running' };
  const live = renderToStaticMarkup(createElement(ReasoningBlock, { state: 'running', process: [step], open: true }));
  // 50 ms batches re-parse Markdown around unclosed fences and reflow the tall block, which read
  // as flicker while the transcript is pinned to the bottom; the live text stays plain.
  assert.ok(live.includes('thinking-text'));
  assert.ok(live.includes('**流式思考**'), 'live text is shown verbatim, not as parsed Markdown');
  assert.ok(!live.includes('message-markdown'));
});

test('streamed markdown commits on a short throttle and the final text renders immediately', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const render = (content, streaming) => act(async () => { root.render(createElement(MessageContent, { content, streaming })); });
  try {
    await render('第一段', true);
    assert.ok(document.body.textContent.includes('第一段'));
    await render('第一段 继续', true);
    // The update may be held for up to ~120 ms, but it must commit without another prop change.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    assert.ok(document.body.textContent.includes('继续'), 'the throttled update still lands');
    // Once the reply completes, the final text renders immediately.
    await render('第一段 继续 结束', false);
    assert.ok(document.body.textContent.includes('结束'));
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('a replaced body animates once instead of mutating the previous transition text', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const render = (content, streaming) => act(async () => { root.render(createElement(MessageContent, { content, streaming })); });
  const body = () => document.querySelector('.message-markdown');
  try {
    await render('先搜索官方文档。', true);
    assert.equal(body().classList.contains('is-replacing'), false, 'normal streaming is not an animation');

    await render('这是最终回答。', true);
    assert.equal(body().classList.contains('is-replacing'), true, 'a rewritten body is animated');
    assert.ok(!document.body.textContent.includes('先搜索官方文档。'));

    await render('这是最终回答。继续', true);
    assert.equal(body().classList.contains('is-replacing'), true,
      'ordinary growth after the swap neither restarts nor cancels the animation');

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 360)); });
    assert.equal(body().classList.contains('is-replacing'), false, 'the class is released after the animation');
    assert.ok(document.body.textContent.includes('这是最终回答。继续'));
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('stopping is neutral and historical failures without a retry callback have no retry button', () => {
  for (const status of ['stopped', 'error']) {
    const { document } = parseHTML(renderToStaticMarkup(createElement(ReplyStatus, { message: { status } })));
    assert.equal(document.querySelector('p').getAttribute('role'), status === 'stopped' ? 'status' : 'alert');
    assert.equal(document.querySelectorAll('button').length, 0);
  }
});

test('the latest failure exposes retry and removes it as soon as the caller starts a new message', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let retries = 0;
  const message = { status: 'error', error: '服务商暂时不可用，请稍后重试。' };
  try {
    await act(async () => root.render(createElement(ReplyStatus, { message, onRetry: () => retries++ })));
    assert.equal(document.querySelector('.reply-retry').textContent, '重试');
    await act(async () => document.querySelector('.reply-retry').click());
    assert.equal(retries, 1);
    await act(async () => root.render(createElement(ReplyStatus, { message })));
    assert.equal(document.querySelector('.reply-retry'), null);
    assert.match(document.querySelector('[role=alert]').textContent, /服务商暂时不可用/);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('search rows aggregate their sources for the panel and report the count', () => {
  const results = Array.from({ length: 8 }, (_, rank) => ({
    rank, title: `Source ${rank}`, url: `https://example.com/${rank}`, domain: 'example.com', snippet: '', engine: 'duckduckgo',
  }));
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'complete', open: true, activities: [
      { id: 'full', kind: 'search', status: 'complete', query: 'query', results },
      { id: 'empty', kind: 'search', status: 'complete', query: 'empty', results: [] },
    ],
  })));
  const row = document.querySelector('.web-activity-toggle');
  assert.equal(row.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelectorAll('.web-activity').length, 1, 'two searches share one row');
  assert.match(document.querySelector('.web-activity-state').textContent, /搜索到 8 个网页/);
  assert.equal(document.querySelector('.web-activity-details'), null, 'sources live in the panel, not under the row');
  assert.equal(document.querySelectorAll('.research-result').length, 0);
  assert.equal(document.querySelector('.reasoning-toggle').getAttribute('aria-expanded'), 'true');
  assert.doesNotMatch(document.body.textContent, /2 次|搜索次数/);
});

test('an all-empty search group says there are no usable results', () => {
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'complete', open: true, activities: [
      { id: 'empty-1', kind: 'search', status: 'complete', query: 'one', results: [] },
      { id: 'empty-2', kind: 'search', status: 'complete', query: 'two', results: [] },
    ],
  })));
  assert.equal(document.querySelectorAll('.web-activity').length, 1);
  assert.match(document.querySelector('.web-activity-state').textContent, /未找到网页/);
  assert.equal(document.querySelector('.web-activity-notes'), null, 'a clean batch folds nothing under the row');
});

test('grouping keeps every raw search query available for storage and debugging', () => {
  const steps = groupResearchSteps([
    { id: 'search-1', kind: 'search', status: 'complete', query: 'first query', results: [] },
    { id: 'search-2', kind: 'search', status: 'complete', query: 'second query', results: [] },
    { id: 'fetch-1', kind: 'fetch', status: 'complete', url: 'https://example.com/a', urls: ['https://example.com/a'] },
  ]);
  const search = steps.find((entry) => entry.type === 'group' && entry.group.kind === 'search');
  assert.ok(search && search.type === 'group');
  assert.deepEqual(search.group.activities.map((activity) => activity.query), ['first query', 'second query']);
});

test('a thinking segment between two searches keeps them as separate rows', () => {
  const steps = groupResearchSteps([
    { id: 'search-1', kind: 'search', status: 'complete', query: 'first query', results: [] },
    { id: 'thought', kind: 'thinking', content: '先停一下', status: 'complete' },
    { id: 'search-2', kind: 'search', status: 'complete', query: 'second query', results: [] },
  ]);
  const searchGroups = steps.filter((entry) => entry.type === 'group' && entry.group.kind === 'search');
  assert.equal(searchGroups.length, 2);
  assert.deepEqual(steps.map((entry) => entry.type === 'group' ? entry.group.kind : entry.step.kind),
    ['search', 'thinking', 'search']);
});

test('result cards fall back to the globe when a favicon is unavailable', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const group = { id: 'research:search:search', kind: 'search', activities: [{ id: 'search', kind: 'search', status: 'complete', query: 'q',
    results: [{ rank: 0, title: 'Source', url: 'https://unreachable.example/x', domain: 'unreachable.example', snippet: '摘要' }] }] };
  try {
    await act(async () => root.render(createElement(ResearchPanel, { group, mode: 'side', onClose: () => {} })));
    const image = document.querySelector('.research-result-icon');
    assert.equal(image.getAttribute('src'), 'https://unreachable.example/favicon.ico');
    assert.equal(document.querySelector('.research-result').getAttribute('href'), 'https://unreachable.example/x');
    assert.equal(document.querySelector('.research-result-domain').textContent, 'unreachable.example');
    assert.equal(document.querySelector('.research-result-snippet').textContent, '摘要');
    await act(async () => { image.dispatchEvent(new window.Event('error')); });
    assert.equal(document.querySelector('.research-result-icon'), null);
    assert.ok(document.querySelector('.research-result svg'), 'falls back to the default globe');
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('thinking disclosure keeps its open state and content across tool, answer and interrupted phases', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const render = async (props) => act(async () => { root.render(createElement(ReasoningBlock, props)); });
  try {
    await render({ state: 'running' });
    await act(async () => { document.querySelector('.reasoning-toggle').click(); });
    assert.equal(document.querySelector('.reasoning-body').textContent, '', 'empty process expands to a blank body');
    assert.equal(document.querySelector('.reasoning-body').hidden, false);
    for (const state of ['running', 'complete', 'stopped', 'error']) {
      await render({ state, reasoning: '已收到的思考', activities: [{ id: 'search', kind: 'search', query: '资料', status: state === 'running' ? 'running' : 'complete', results: [] }] });
      assert.equal(document.querySelector('.reasoning-toggle').getAttribute('aria-expanded'), 'true');
      assert.equal(document.querySelector('.reasoning-label').textContent, '思考过程');
      // Thinking reads open by default; folding it is the reader's own choice.
      assert.equal(document.querySelector('.thinking-toggle').getAttribute('aria-expanded'), 'true');
      assert.ok(document.querySelector('.thinking-body').textContent.includes('已收到的思考'));
      assert.equal(document.querySelector('.thinking-body').hidden, false);
      await act(async () => { document.querySelector('.thinking-toggle').click(); });
      assert.equal(document.querySelector('.thinking-body').hidden, true);
      await act(async () => { document.querySelector('.thinking-toggle').click(); });
      assert.equal(document.querySelector('.thinking-body').hidden, false);
      assert.equal(document.querySelector('.response-sources'), null);
    }
    await act(async () => { document.querySelector('.reasoning-toggle').click(); });
    assert.equal(document.querySelector('.thinking-body'), null, 'collapsed text unmounts to avoid streaming Markdown work');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('thinking segments start open and fold only when the reader closes them', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const thought = (status, extra = {}) => ({ id: 't1', kind: 'thinking', content: '先想一下', status, ...extra });
  const search = { id: 's1', kind: 'search', status: 'complete', query: '资料', results: [] };
  const render = (process, state = 'running') => act(async () => {
    root.render(createElement(ReasoningBlock, { open: true, state, process }));
  });
  const rows = () => [...document.querySelectorAll('.thinking-toggle')];
  try {
    // The segment being written reads inline, and so does a finished one.
    await render([thought('running')]);
    assert.equal(rows()[0].getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelector('.thinking-body').hidden, false);
    assert.equal(rows()[0].textContent, '思考', 'an open thought repeats nothing above its own text');

    await render([thought('complete')]);
    assert.equal(rows()[0].getAttribute('aria-expanded'), 'true');
    assert.ok(document.querySelector('.thinking-body').textContent.includes('先想一下'));
    assert.equal(rows()[0].querySelector('.thinking-preview'), null, 'an open segment shows no teaser');

    // Every segment, old or live, keeps its text open.
    await render([thought('complete'), search, thought('running', { id: 't2', content: '再想一下' })]);
    assert.deepEqual(rows().map((row) => row.getAttribute('aria-expanded')), ['true', 'true']);

    // Folding is the reader's call, and it survives a re-render while the status is unchanged.
    await act(async () => { rows()[0].click(); });
    assert.equal(rows()[0].getAttribute('aria-expanded'), 'false');
    assert.equal(rows()[0].querySelector('.thinking-preview').textContent, '先想一下');
    await render([thought('complete'), search, thought('running', { id: 't2', content: '再想一下' })]);
    assert.equal(rows()[0].getAttribute('aria-expanded'), 'false');

    // A folded row's teaser is one line of prose: fences, links and markdown markers do not reach it.
    await render([thought('complete', { content: '**结论**：先看 [官方文档](https://example.com/a)\n\n```ts\nconst x = 1;\n```\n后面还有内容' }), search], 'complete');
    assert.match(rows()[0].querySelector('.thinking-preview').textContent, /^结论：先看 官方文档/);
    assert.ok(!rows()[0].querySelector('.thinking-preview').textContent.includes('```'));
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('the display switches hide or fold thinking segments', () => {
  const process = [
    { id: 't1', kind: 'thinking', content: '先想一下', status: 'complete' },
    { id: 's1', kind: 'search', status: 'complete', query: '资料', results: [] },
  ];
  const hidden = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'complete', open: true, process, showThinking: false,
  }))).document;
  assert.equal(hidden.querySelectorAll('.thinking-step').length, 0, 'thinking blocks can be hidden entirely');
  assert.equal(hidden.querySelectorAll('.web-activity').length, 1, 'tool rows stay');

  const folded = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'complete', open: true, process, thinkingExpanded: false,
  }))).document;
  assert.equal(folded.querySelector('.thinking-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(folded.querySelector('.thinking-preview').textContent, '先想一下');
});

test('a long transcript closes from its own end instead of the header far above', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const render = (props) => act(async () => { root.render(createElement(ReasoningBlock, props)); });
  try {
    await render({ state: 'complete', reasoning: '很长的思考' });
    assert.equal(document.querySelector('.reasoning-collapse'), null, 'a closed block has nothing to close');

    await act(async () => { document.querySelector('.reasoning-toggle').click(); });
    assert.equal(document.querySelector('.reasoning-collapse'), null,
      'a short transcript keeps the fold control out of the way');

    // linkedom has no layout or ResizeObserver. Measure a tall transcript on the instance and
    // re-render with one more step so the height effect runs again.
    Object.defineProperty(document.querySelector('.reasoning-steps'), 'scrollHeight', { configurable: true, value: 600 });
    await render({ state: 'complete', reasoning: '很长的思考',
      activities: [{ id: 'search', kind: 'search', status: 'complete', query: '资料', results: [] }] });
    const collapse = document.querySelector('.reasoning-collapse');
    assert.ok(collapse, 'a tall transcript gets a footer control');
    assert.equal(collapse.parentElement.className, 'reasoning-body');
    assert.equal(collapse.parentElement.lastElementChild, collapse, 'the control follows the transcript');
    assert.equal(collapse.textContent, '收起思考过程');

    // The footer control must work while the reader is deep in the transcript, i.e. without
    // touching the header, and it must not leave focus on the page body afterwards. linkedom has
    // no activeElement, so the header's focus call is observed instead.
    let focused = null;
    document.querySelector('.reasoning-toggle').focus = (options) => { focused = options; };
    await act(async () => { collapse.click(); });
    assert.equal(document.querySelector('.reasoning-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('.reasoning-body').hidden, true);
    assert.equal(document.querySelector('.reasoning-collapse'), null);
    assert.deepEqual(focused, { preventScroll: true }, 'focus returns to the header that stays on screen');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('a research row opens the result panel and marks itself expanded instead of unfolding', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const activity = { id: 'batch', kind: 'fetch', url: 'https://example.com/a', urls: ['https://example.com/a', 'https://example.com/b'] };
  const opened = [];
  // `openResearchId` stands in for the panel the screen keeps beside the conversation.
  const render = (status, openId = null) => act(async () => root.render(createElement(ReasoningBlock, {
    open: true, state: status === 'running' ? 'running' : 'complete', activities: [{ ...activity, status }],
    openResearchId: openId, onOpenResearch: (group, opener) => opened.push({ group, opener }),
  })));
  const row = () => document.querySelector('.web-activity-toggle');
  try {
    await render('running');
    assert.equal(row().getAttribute('aria-haspopup'), 'dialog');
    assert.equal(row().getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('.web-activity-details'), null, 'nothing unfolds under the row');
    await act(async () => row().click());
    assert.equal(opened.length, 1);
    assert.equal(opened[0].group.kind, 'fetch');
    assert.deepEqual(opened[0].group.activities.map((item) => item.id), ['batch']);
    assert.equal(opened[0].opener, row(), 'the screen gets the row back to restore focus to');
    await render('complete', opened[0].group.id);
    assert.equal(row().getAttribute('aria-expanded'), 'true', 'the open panel marks its row');
    await render('complete', 'research:fetch:other');
    assert.equal(row().getAttribute('aria-expanded'), 'false');
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('the result panel lists search hits and read pages and closes on Esc or the close button', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const search = { id: 'research:search:s1', kind: 'search', activities: [
    { id: 's1', kind: 'search', status: 'complete', query: 'q', results: [
      { rank: 1, title: 'Python docs', url: 'https://docs.python.org/a', domain: 'docs.python.org', snippet: '第一段摘要' },
      { rank: 2, title: 'Python docs', url: 'https://docs.python.org/a#task', domain: 'docs.python.org', snippet: '去重后的同页' },
      { rank: 3, title: 'Guide', url: 'https://example.com/g', domain: 'example.com', snippet: '' },
    ] },
  ] };
  const fetch = { id: 'research:fetch:f1', kind: 'fetch', activities: [
    { id: 'f1', kind: 'fetch', status: 'complete', url: 'https://example.com/a', urls: ['https://example.com/a', 'https://example.com/b'], title: '示例页' },
  ] };
  let closes = 0;
  const focused = [];
  // linkedom has no activeElement, so the panel's focus call is observed instead.
  const focus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function (options) { focused.push({ element: this, options }); };
  const render = (group) => act(async () => root.render(createElement(ResearchPanel, { group, mode: 'side', onClose: () => closes++ })));
  try {
    await render(search);
    assert.equal(document.querySelector('.research-panel-header h2').textContent, '搜索结果');
    const cards = [...document.querySelectorAll('.research-result')];
    assert.equal(cards.length, 2, 'the same URL with a different hash is one source');
    assert.deepEqual(cards.map((card) => card.querySelector('.research-result-title').textContent), ['Python docs', 'Guide']);
    assert.equal(cards[0].querySelector('.research-result-snippet').textContent, '第一段摘要');
    assert.equal(cards[1].querySelector('.research-result-snippet'), null, 'a missing snippet leaves no empty line');
    assert.ok(focused.some((entry) => entry.element.classList?.contains('research-panel')), 'focus moves into the panel');
    assert.deepEqual(focused.at(-1)?.options, { preventScroll: true });

    await act(async () => {
      // linkedom does not expose KeyboardEvent; a keydown Event carrying `key` is enough for React.
      const escape = new window.Event('keydown', { bubbles: true });
      escape.key = 'Escape';
      document.querySelector('.research-panel').dispatchEvent(escape);
    });
    assert.equal(closes, 1);
    await act(async () => { document.querySelector('.research-panel-header button').click(); });
    assert.equal(closes, 2);

    await render(fetch);
    assert.equal(document.querySelector('.research-panel-header h2').textContent, '读取的网页');
    const pages = [...document.querySelectorAll('.research-result')];
    assert.equal(pages.length, 2);
    assert.equal(pages[0].querySelector('.research-result-title').textContent, '示例页');
    assert.equal(pages[0].querySelector('.research-result-url').textContent, 'https://example.com/a');
  } finally {
    window.HTMLElement.prototype.focus = focus;
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('the result panel explains an empty or still-running batch', () => {
  const complete = groupResearchSteps([
    { id: 'empty', kind: 'search', status: 'complete', query: 'q', results: [] },
  ]).find((entry) => entry.type === 'group').group;
  const running = groupResearchSteps([
    { id: 'pending', kind: 'fetch', status: 'running', urls: ['https://example.com/a'] },
  ]).find((entry) => entry.type === 'group').group;
  const { document } = parseHTML(renderToStaticMarkup(createElement(ResearchPanel, { group: complete, mode: 'side', onClose: () => {} })));
  assert.match(document.querySelector('.research-empty').textContent, /未找到可用结果/);
  const live = parseHTML(renderToStaticMarkup(createElement(ResearchPanel, { group: running, mode: 'side', onClose: () => {} }))).document;
  // A page still being read is not a source yet: the panel says it is working instead of listing
  // the URL as if it had been read.
  assert.match(live.querySelector('.research-empty').textContent, /正在读取页面/);
  assert.equal(live.querySelector('.research-result'), null);
});

test('the narrow-viewport sheet shows the same list in a bottom dialog', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT, HTMLElement: globalThis.HTMLElement };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const group = { id: 'research:search:s1', kind: 'search', activities: [
    { id: 's1', kind: 'search', status: 'complete', query: 'q', results: [
      { rank: 1, title: 'Python docs', url: 'https://docs.python.org/a', domain: 'docs.python.org', snippet: '摘要' },
    ] },
  ] };
  let closes = 0;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  try {
    await act(async () => root.render(createElement(ResearchPanel, { group, mode: 'sheet', onClose: () => closes++ })));
    const dialog = document.querySelector('dialog.research-sheet');
    assert.ok(dialog, 'the sheet is a dialog in the top layer');
    assert.equal(dialog.querySelector('.dialog-header h2').textContent, '搜索结果');
    assert.equal(dialog.querySelectorAll('.research-result').length, 1);
    await act(async () => { dialog.querySelector('.dialog-header button').click(); });
    assert.equal(closes, 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('a partially failed batch still opens the panel, and the panel names the skipped pages', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const opened = [];
  const activity = { id: 'partial', kind: 'fetch', status: 'complete', urls: ['https://example.com/a'], title: '示例',
    error: '1 个网页未能读取，已保留其余可用来源。' };
  try {
    await act(async () => root.render(createElement(ReasoningBlock, {
      state: 'complete', open: true, activities: [activity],
      onOpenResearch: (...args) => opened.push(args),
    })));
    const row = () => document.querySelector('.web-activity-toggle');
    assert.equal(document.querySelector('.web-activity-notes'), null, 'the transcript does not grow a failure line');
    assert.doesNotMatch(document.querySelector('.web-activity-state').textContent, /部分失败/);
    await act(async () => row().click());
    assert.equal(opened.length, 1, 'one readable page is enough to open the panel');
    assert.equal(document.querySelector('.web-activity-details'), null);

    const panel = parseHTML(renderToStaticMarkup(createElement(ResearchPanel, {
      group: opened[0][0], mode: 'side', onClose: () => {},
    }))).document;
    assert.equal(panel.querySelectorAll('.research-result').length, 1);
    assert.equal(panel.querySelector('.research-note.is-error').textContent, '1 个网页未能读取，已保留其余可用来源。');
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('a batch with no readable page folds its reason under the row instead of opening the panel', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const opened = [];
  try {
    await act(async () => root.render(createElement(ReasoningBlock, {
      state: 'error', open: true,
      activities: [{ id: 'dead', kind: 'fetch', status: 'error', url: 'https://example.com/dead', error: '网页读取超时。' }],
      onOpenResearch: (...args) => opened.push(args),
    })));
    const row = () => document.querySelector('.web-activity-toggle');
    assert.equal(document.querySelector('.web-activity-notes').hidden, true);
    await act(async () => row().click());
    assert.equal(document.querySelector('.web-activity-notes').hidden, false);
    assert.equal(document.querySelector('.web-activity-notes .web-activity-error').textContent, '网页读取超时。');
    assert.equal(opened.length, 0, 'nothing to list means no panel');
    await act(async () => row().click());
    assert.equal(document.querySelector('.web-activity-notes').hidden, true);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('a successful file operation is a plain row, while a failed one opens its details', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const render = (activity) => act(async () => root.render(createElement(ReasoningBlock, {
    state: 'complete', open: true, activities: [activity],
  })));
  const ok = { id: 'file-ok', kind: 'file', operation: 'edit', status: 'complete', filename: '报告.docx', tookMs: 1200 };
  try {
    await render(ok);
    assert.ok(document.querySelector('.file-activity .web-activity-row'), 'a clean file row is not a button');
    assert.equal(document.querySelector('.file-activity .web-activity-toggle'), null);
    assert.equal(document.querySelector('.web-activity-details'), null);
    assert.match(document.querySelector('.web-activity-state').textContent, /已编辑文档/);
    const failed = { ...ok, id: 'file-bad', status: 'error', error: '文件不存在。', tookMs: 30 };
    await render(failed);
    const row = document.querySelector('.file-activity .web-activity-toggle');
    assert.ok(row, 'a failed file row can be opened');
    assert.equal(row.getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('.web-activity-details').hidden, true);
    assert.equal(document.querySelector('.file-activity .web-activity-state'), null, 'a folded failure keeps only the icon');
    await act(async () => row.click());
    assert.equal(document.querySelector('.web-activity-details').hidden, false);
    assert.match(document.querySelector('.file-activity .web-activity-state').textContent, /编辑文档失败/);
    assert.match(document.querySelector('.web-activity-error').textContent, /文件不存在/);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('the process keeps non-adjacent search and fetch runs in event order', () => {
  const process = [
    { id: 'first', kind: 'thinking', content: '先搜索', status: 'complete' },
    { id: 'search-1', kind: 'search', status: 'complete', query: 'Python', results: [
      { rank: 1, title: 'Python docs', url: 'https://docs.python.org/a', domain: 'docs.python.org' },
      { rank: 2, title: 'Python guide', url: 'https://example.com/python', domain: 'example.com' },
    ] },
    { id: 'fetch-1', kind: 'fetch', status: 'complete', url: 'https://example.com/a', urls: ['https://example.com/a'] },
    { id: 'second', kind: 'thinking', content: '再分析', status: 'running' },
    { id: 'search-2', kind: 'search', status: 'complete', query: 'Python asyncio', results: [
      { rank: 3, title: 'Python asyncio', url: 'https://docs.python.org/b', domain: 'docs.python.org' },
    ] },
    { id: 'fetch-2', kind: 'fetch', status: 'complete', url: 'https://example.com/b', urls: ['https://example.com/b'] },
  ];
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'running', open: true, reasoning: 'legacy merged transcript', process,
  })));
  const steps = [...document.querySelector('.reasoning-steps').children];
  assert.equal(steps.length, 6, 'a thinking segment separates both tool runs');
  assert.ok(steps[0].querySelector('.thinking-body').textContent.includes('先搜索'));
  assert.equal(steps[1].querySelectorAll('.web-activity').length, 1);
  assert.match(steps[1].querySelector('.web-activity-state').textContent, /搜索到 2 个网页/);
  assert.equal(steps[2].querySelectorAll('.web-activity').length, 1);
  assert.match(steps[2].querySelector('.web-activity-state').textContent, /浏览了 1 个页面/);
  assert.equal(steps[3].querySelector('.thinking-toggle').getAttribute('aria-expanded'), 'true');
  assert.ok(steps[3].querySelector('.thinking-body').textContent.includes('再分析'));
  assert.equal(steps[4].querySelectorAll('.web-activity').length, 1);
  assert.match(steps[4].querySelector('.web-activity-state').textContent, /搜索到 1 个网页/);
  assert.equal(steps[5].querySelectorAll('.web-activity').length, 1);
  assert.match(steps[5].querySelector('.web-activity-state').textContent, /浏览了 1 个页面/);
  assert.ok(!document.body.textContent.includes('legacy merged transcript'));
  assert.doesNotMatch(document.body.textContent, /2 次搜索|搜索次数/);
});

test('adjacent search and fetch runs merge while keeping their order', () => {
  const process = [
    { id: 'first', kind: 'thinking', content: '先搜索', status: 'complete' },
    { id: 'search-1', kind: 'search', status: 'complete', query: 'Python', results: [
      { rank: 1, title: 'Python docs', url: 'https://docs.python.org/a', domain: 'docs.python.org' },
      { rank: 2, title: 'Python guide', url: 'https://example.com/python', domain: 'example.com' },
    ] },
    { id: 'search-2', kind: 'search', status: 'complete', query: 'Python asyncio', results: [
      { rank: 3, title: 'Python asyncio', url: 'https://docs.python.org/b', domain: 'docs.python.org' },
    ] },
    { id: 'fetch-1', kind: 'fetch', status: 'complete', url: 'https://example.com/a', urls: ['https://example.com/a'] },
    { id: 'fetch-2', kind: 'fetch', status: 'complete', url: 'https://example.com/b', urls: ['https://example.com/b'] },
    { id: 'second', kind: 'thinking', content: '再分析', status: 'running' },
  ];
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'running', open: true, process,
  })));
  const steps = [...document.querySelector('.reasoning-steps').children];
  assert.equal(steps.length, 4, 'search → search and fetch → fetch collapse into one row each');
  assert.match(steps[1].querySelector('.web-activity-state').textContent, /搜索到 3 个网页/);
  assert.match(steps[2].querySelector('.web-activity-state').textContent, /浏览了 2 个页面/);
  assert.equal(steps[3].querySelector('.thinking-toggle').getAttribute('aria-expanded'), 'true');
});

function render(content) { return renderToStaticMarkup(createElement(MessageContent, { content })); }
function documentFor(content) { return parseHTML(render(content)).document; }

test('the local KaTeX stylesheet and every referenced font match the renderer version', () => {
  const require = createRequire(import.meta.url);
  const version = require('katex/package.json').version;
  const base = new URL(`../public/vendor/katex/${version}/`, import.meta.url);
  const css = readFileSync(new URL('katex.min.css', base), 'utf8');
  assert.ok(css.includes(`content:"${version}"`));
  const fonts = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(fonts.length >= 20);
  for (const font of fonts) assert.ok(existsSync(new URL(font, base)), font);
});

test('CommonMark and GFM render real headings, lists, quotes, tables, tasks and footnotes', () => {
  const content = '# Heading\n\n**bold** *italic* ~~removed~~ `inline`\n\n> Quote\n\n- [x] Done\n- [ ] Pending\n\n1. One\n2. Two\n\n| A | B |\n| --- | --- |\n| x | y |\n\nFootnote[^a]\n\n[^a]: The note';
  const doc = documentFor(content);
  for (const tag of ['h1', 'strong', 'em', 'del', 'code', 'blockquote', 'ul', 'ol', 'table', 'th', 'td']) assert.ok(doc.querySelector(tag), tag);
  assert.equal(doc.querySelectorAll('input[type=checkbox]').length, 2);
  const reference = doc.querySelector('a[data-footnote-ref]');
  assert.ok(doc.getElementById(reference.getAttribute('href').slice(1)));
});

test('emphasis delimited by CJK punctuation still renders as emphasis', () => {
  // CommonMark's delimiter rules only count Unicode punctuation and whitespace, so `**` next to a
  // Chinese quotation mark fails the left-flanking test and the markers are shown as literal text.
  const doc = documentFor('是两只**“还不算完全是鸡的原鸡祖先”进行了交配，孵出了第一只鸡**。');
  assert.equal(doc.querySelector('strong').textContent, '“还不算完全是鸡的原鸡祖先”进行了交配，孵出了第一只鸡');
  assert.ok(!doc.body.textContent.includes('**'));
  // Ordinary emphasis and literal asterisks keep their existing meaning.
  assert.equal(documentFor('**加粗**').querySelector('strong').textContent, '加粗');
  assert.equal(documentFor('2 * 3 * 4').querySelector('em'), null);
});

test('math renders fractions, matrices and both provider delimiter styles', () => {
  for (const content of ['$3.14159$', '$E=mc^2$', '$\\frac{1}{2}$', '$$\\sqrt{x^2}$$', '\\(x_i^2\\)', '\\[\\sum_{n=1}^{10} n\\]', '$$\n\\begin{bmatrix}1 & 0 \\\\ 0 & 1\\end{bmatrix}\n$$']) {
    const doc = documentFor(content);
    assert.ok(doc.querySelector('.katex'), content);
    assert.equal(doc.querySelector('.katex-source'), null, content);
    assert.ok(doc.querySelector('math'), 'accessible MathML');
  }
});

test('a display block still renders when its opening $$ shares a line with prose', () => {
  const aligned = '\\begin{aligned}\nx &= 1 \\\\\n&= 2\n\\end{aligned}';
  for (const content of [`计算：$$\n${aligned}\n$$`, `计算：$$${aligned}$$`, `计算：$$\n${aligned}\n$$\n\n以上。`]) {
    const doc = documentFor(content);
    assert.ok(doc.querySelector('.katex-display'), content);
    assert.equal(doc.querySelector('.katex-source'), null, content);
    assert.match(doc.querySelector('.message-markdown').textContent, /计算：/, content);
  }
});

test('an inline $$ pair stays where it is, inside its sentence, list item and table cell', () => {
  const paragraph = documentFor('设 $$y = x^2$$ 为抛物线。');
  assert.equal(paragraph.querySelector('.katex-display'), null);
  assert.match(paragraph.querySelector('p').textContent, /^设 .* 为抛物线。$/);

  const list = documentFor('- 项一 $$x^2$$\n- 项二');
  assert.equal(list.querySelectorAll('ul').length, 1, 'the list is not split in two');
  assert.equal(list.querySelectorAll('li').length, 2);
  assert.ok(list.querySelector('li .katex'));

  const table = documentFor('| 公式 | 说明 |\n| --- | --- |\n| $$\\frac{1}{2}$$ | 一半 |');
  assert.equal(table.querySelector('.katex-display'), null, 'nothing is hoisted out of the table');
  assert.equal(table.querySelectorAll('tbody td').length, 2);
  assert.ok(table.querySelector('td .katex'));
  assert.match(table.querySelectorAll('tbody td')[1].textContent, /一半/);
});

test('a $$ pair covering whole lines is still a display block', () => {
  const doc = documentFor('文字\n\n$$x^2$$\n\n后面');
  assert.ok(doc.querySelector('.katex-display'));
  assert.equal(doc.querySelector('.katex-source'), null);
});

test('an environment a model pasted without delimiters still renders as math', () => {
  // Providers that are not told to delimit math paste the environment bare; markdown then eats the
  // backslashes (`\,` becomes `,`, `\\` becomes `\`) and the derivation arrives as a wall of source.
  const aligned = '\\begin{aligned}\n\\iint_D xy \\, dxdy &= \\int_0^1 dx \\int_{x^2}^x xy \\, dy \\\\\n&= \\frac{1}{24}\n\\end{aligned}';
  const body = (markdown) => {
    const markup = parseHTML('<div>' + parseHTML(render(markdown)).document.querySelector('.message-markdown').innerHTML + '</div>').document.querySelector('div');
    for (const element of markup.querySelectorAll('code, pre, annotation')) element.remove();
    return markup.textContent;
  };
  for (const content of [`列式并计算：\n${aligned}`, `3. **列式并计算：**\n${aligned}\n\n以上。`, `矩阵：\\begin{bmatrix}1 & 0 \\\\ 0 & 1\\end{bmatrix}`]) {
    const doc = documentFor(content);
    assert.ok(doc.querySelector('.katex'), content);
    assert.equal(doc.querySelector('.katex-source'), null, content);
    assert.ok(!body(content).includes('\\begin{'), content);
    assert.ok(!body(content).includes('\\\\'), content);
  }

  // The fallback runs after every delimited formula is a placeholder, so a delimited environment is
  // never wrapped a second time, and text already inside a fence or span is left alone.
  assert.equal(documentFor('行内 $\\begin{aligned} a &= b \\end{aligned}$ 结束。').querySelectorAll('.katex').length, 1);
  const code = documentFor('```tex\n\\begin{aligned}\nx &= 1\n\\end{aligned}\n```');
  assert.equal(code.querySelector('.katex'), null);
  assert.match(code.querySelector('code').textContent, /\\begin\{aligned\}/);
});

test('a $$ pair left open across prose does not swallow that prose into one KaTeX error', () => {
  // The failure this guards against: `$$` opens, the body runs on through a blank line, a bolded
  // heading and a nested `$X$`, and remark-math hands the whole stretch to KaTeX. Everything
  // between the delimiters came back as the formula renderer's error source — asterisks included.
  const body = (content) => {
    const markup = parseHTML('<div>' + parseHTML(render(content)).document.querySelector('.message-markdown').innerHTML + '</div>').document.querySelector('div');
    for (const element of markup.querySelectorAll('code, pre, annotation')) element.remove();
    return markup.textContent;
  };
  const content = '求交点：\n\n$$\n\\begin{cases} y = x \\\\ y = x^2 \\end{cases} \\implies x^2 - x = 0\n\n**选择积分次序并限定：**\n该区域是 $X$-型。\n$$';
  const doc = documentFor(content);
  assert.equal(doc.querySelector('.katex-source'), null);
  assert.ok(doc.querySelector('strong'), 'markdown inside the body still renders as markdown');
  assert.ok(doc.querySelector('.katex-display'), 'the environment inside the body still renders as math');
  assert.ok(!body(content).includes('**'), 'the bold markers do not reach the screen');
  assert.ok(!body(content).includes('\\implies'), 'the derivation joins the formula instead of leaking');

  // A derivation that runs past `\end{…}` on the same line is one formula, not a formula plus tail.
  const tail = body('\\begin{cases} y = x \\\\ y = x^2 \\end{cases} \\implies x^2 - x = 0 \\implies x = 0');
  assert.ok(!tail.includes('\\implies') && !tail.includes('\\begin{'), tail);
  assert.equal(documentFor('\\begin{cases} y = x \\end{cases} 其中 y 是纵坐标').querySelector('.katex-error'), null, 'prose after the environment stays prose');
});

test('normalizing is idempotent, so a streamed reply that is re-rendered mid-flight stays stable', () => {
  for (const content of ['列式并计算：\n\\begin{aligned}\\iint_D xy \\, dxdy &= \\frac{1}{24}\\end{aligned}', '计算：$$\n\\begin{aligned}x &= 1\\end{aligned}\n$$', '$$\\frac{1}{2}$$ 与 $x^2$ 与 $5.00', '求交点：\n\n$$\n\\begin{cases} y = x\\end{cases} \\implies x = 0\n\n**接下来：**\n$$', '\\begin{cases} y = x \\end{cases} 其中 y 是纵坐标']) {
    assert.equal(normalizeMarkdown(normalizeMarkdown(content)), normalizeMarkdown(content), content);
  }
});

test('currency stays text alongside real math and code', () => {
  const doc = documentFor('输入 **$5.00 / 1M tokens**，输出 **$30.00 / 1M tokens**。金额 $20 和 $1,000。公式 $3.14159$ 与 $x^2$。代码 `$20`。');
  assert.equal(doc.querySelectorAll('.katex').length, 2);
  assert.match(doc.querySelector('.message-markdown').textContent, /\$5\.00/);
  assert.match(doc.querySelector('.message-markdown').textContent, /\$30\.00/);
  assert.match(doc.querySelector('.message-markdown').textContent, /\$1,000/);
  assert.equal(doc.querySelector('code').textContent, '$20');
});

test('code is preserved across alternate fences, code spans and unclosed blocks', () => {
  for (const content of ['```js\nconst price = "$20";\n\\(x\\)\n```', '~~~text\n$20 and $30\n~~~', '`` `$20` and $30 ``', '```text\n$20 and $30', '````md\n```text\n$20\n```\n````']) assert.equal(normalizeMarkdown(content), content);
  const doc = documentFor('```js\nconst price = "$20";\n\n');
  assert.ok(doc.querySelector('.message-code'));
  assert.equal(doc.querySelector('pre code').textContent, 'const price = "$20";\n');
});

test('untrusted HTML, URLs and KaTeX commands cannot become active content', () => {
  const doc = documentFor('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1))\n\n$\\href{javascript:alert(1)}{x}$');
  assert.equal(doc.querySelector('script, img[onerror], [href^="javascript:"]'), null);
});

test('highlighting loads requested languages, escapes code and falls back safely', async () => {
  for (const [language, code] of [['tsx', 'const App = () => <p>Hello</p>;'], ['python', 'def greet():\n    return "hello"'], ['sql', 'SELECT * FROM messages;'], ['json', '{"ok": true}'], ['bash', 'echo "hello"']]) {
    assert.match(await highlightCode(code, language), /class="hljs-/);
  }
  assert.equal(await highlightCode('hello', 'not-a-language'), null);
  assert.equal(await highlightCode('hello', 'constructor'), null);
  assert.equal(await highlightCode('x'.repeat(50_001), 'js'), null);
  const html = await highlightCode('<script>alert(1)</script>', 'html');
  assert.ok(!html.includes('<script>'));
  assert.equal(parseHTML(`<div>${html}</div>`).document.querySelector('div').textContent, '<script>alert(1)</script>');
});

test('all Mock replies render without a KaTeX parse error except the intentional truncated formula', () => {
  for (const conversation of createDemoWorkspace().chat.conversations) {
    // Bulk threads reuse the same examples; the focused cases cover every format.
    if (conversation.id.startsWith('dev-chat-')) continue;
    for (const message of conversation.messages) {
      const html = render(message.content);
      assert.ok(html.length > 0);
      if (conversation.id !== 'dev-render-partial') assert.ok(!html.includes('katex-source'), conversation.id);
    }
  }
});

test('code block supports collapse, expand, raw copying and clipboard failures', async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = { window: globalThis.window, document: globalThis.document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let copied;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text) => { copied = text; } } } });
  const root = createRoot(document.getElementById('root'));
  const source = 'const price = "$20";\n';
  try {
    await act(async () => { root.render(createElement(CodeBlock, { code: source, language: 'js' })); });
    assert.ok(document.querySelector('pre code .hljs-keyword'));
    const toggle = () => document.querySelector('button[aria-expanded]');
    await act(async () => { toggle().click(); });
    assert.equal(toggle().getAttribute('aria-expanded'), 'false');
    assert.equal(document.querySelector('pre').hidden, true);
    await act(async () => { document.querySelector('button[aria-label="复制代码"]').click(); });
    assert.equal(copied, source);
    assert.equal(document.querySelector('[role=status]').textContent, '已复制');
    await act(async () => { toggle().click(); });
    assert.equal(document.querySelector('pre').hidden, false);
    assert.equal(document.querySelector('pre code').textContent, source);
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    await act(async () => { document.querySelector('button[aria-label="复制代码"]').click(); });
    assert.match(document.querySelector('[role=status]').textContent, /复制失败/);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('conversation titles scroll only on overflow and engagement, cancel on exit and respect reduced motion', async () => {
  const { ConversationSelect } = await import('../src/features/chat/components/conversation-select.tsx');
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  window.matchMedia = () => media;
  const root = createRoot(document.getElementById('root'));
  let selections = 0;
  let animations = 0;
  let cancelled = 0;
  try {
    await act(async () => { root.render(createElement(ConversationSelect, { title: '这是一个足够长的完整会话标题', active: true, onSelect: () => selections++ })); });
    const button = document.querySelector('button');
    const viewport = document.querySelector('.conversation-title');
    const label = document.querySelector('.conversation-title-text');
    const matches = button.matches.bind(button);
    button.matches = (selector) => selector === ':focus-visible' || matches(selector);
    let textWidth = 400;
    Object.defineProperty(viewport, 'clientWidth', { get: () => 150 });
    Object.defineProperty(label, 'scrollWidth', { get: () => textWidth });
    label.animate = (frames, options) => {
      animations++;
      assert.equal(frames.at(-1).transform, 'translateX(-250px)');
      assert.equal(options.direction, 'alternate');
      return { cancel: () => cancelled++ };
    };
    const send = async (type) => { await act(async () => { button.dispatchEvent(new window.Event(type, { bubbles: true })); }); };
    assert.equal(animations, 0);
    await send('mouseover');
    assert.equal(animations, 1);
    assert.equal(viewport.dataset.scrolling, 'true');
    await send('mouseout');
    assert.equal(cancelled, 1);
    assert.equal(viewport.dataset.scrolling, undefined);
    await send('focusin');
    assert.equal(animations, 2);
    await act(async () => { button.click(); });
    assert.equal(selections, 1);
    await send('focusout');
    assert.equal(cancelled, 2);
    textWidth = 100;
    await send('mouseover');
    assert.equal(animations, 2);
    assert.equal(viewport.dataset.scrolling, undefined);
    await send('mouseout');
    textWidth = 400;
    media.matches = true;
    await send('mouseover');
    assert.equal(animations, 2);
    assert.equal(viewport.dataset.manual, 'true');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('message actions copy original text, toggle exclusive feedback and invoke fork; user messages have copy only', async () => {
  const { MessageActions } = await import('../src/features/chat/components/message-actions.tsx');
  const { ChatProvider, useChat } = await import('../src/features/chat/chat-state.tsx');
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = { window: globalThis.window, document: globalThis.document, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let copied;
  let forks = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text) => { copied = text; } } } });
  const root = createRoot(document.getElementById('root'));
  const message = { id: 'a1', role: 'assistant', content: '**原始 Markdown**\n\n```ts\nconst x = 1;\n```' };
  let chat;
  function Harness() {
    chat = useChat();
    return createElement(MessageActions, { message: chat.conversations[0].messages[0], onFork: () => forks++, onFeedback: (feedback) => chat.dispatch({ type: 'feedback', conversationId: 'chat', messageId: message.id, feedback }) });
  }
  const renderActions = (key) => createElement(ChatProvider, { initialState: { conversations: [{ id: 'chat', title: 'test', pinned: false, updatedAt: 1, messages: [message] }], activeId: 'chat', sidebarOpen: true, lastThinkingEffort: 'default' } }, createElement(Harness, { key }));
  const click = async (name) => { await act(async () => { document.querySelector(`button[aria-label="${name}"]`).click(); }); };
  const pressed = (name) => document.querySelector(`button[aria-label="${name}"]`).getAttribute('aria-pressed');
  try {
    await act(async () => { root.render(renderActions('first')); });
    assert.equal(document.querySelectorAll('button').length, 4);
    await click('复制消息');
    assert.equal(copied, message.content);
    await click('赞');
    assert.equal(pressed('赞'), 'true');
    assert.equal(chat.conversations[0].messages[0].feedback, 'good');
    await act(async () => { root.render(renderActions('remount')); });
    assert.equal(pressed('赞'), 'true', 'feedback is restored from the message after a UI remount');
    assert.equal(pressed('踩'), 'false');
    await click('踩');
    assert.equal(pressed('赞'), 'false');
    assert.equal(pressed('踩'), 'true');
    await click('踩');
    assert.equal(pressed('踩'), 'false');
    assert.equal(chat.conversations[0].messages[0].feedback, undefined, 'clicking again removes the stored feedback');
    await click('从此处创建分支对话');
    assert.equal(forks, 1);
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    await click('复制消息');
    assert.match(document.querySelector('[role=status]').textContent, /复制失败/);
    assert.ok(document.querySelector('.copy-failed'));
    await act(async () => { root.render(createElement(MessageActions, { message: { id: 'u1', role: 'user', content: 'hello' } })); });
    assert.equal(document.querySelectorAll('button').length, 1);
    assert.equal(document.querySelector('button').getAttribute('aria-label'), '复制消息');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator);
    else delete globalThis.navigator;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('fork creates an independent conversation through the selected assistant message without changing its source', async () => {
  const { ChatProvider, useChat } = await import('../src/features/chat/chat-state.tsx');
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const source = { id: 'original', title: '原会话', pinned: true, updatedAt: 1, messages: [
    { id: 'u1', role: 'user', content: 'question', quote: '引用历史原文' },
    { id: 'a1', role: 'assistant', content: 'answer', feedback: 'bad' },
    { id: 'u2', role: 'user', content: 'follow up' },
    { id: 'a2', role: 'assistant', content: 'later answer' },
  ] };
  let state;
  function Harness() { state = useChat(); return null; }
  try {
    await act(async () => { root.render(createElement(ChatProvider, { initialState: { conversations: [source], activeId: source.id, sidebarOpen: true } }, createElement(Harness))); });
    const fork = { type: 'fork', conversationId: source.id, messageId: 'a1', forkId: 'branch', updatedAt: 42 };
    await act(async () => { state.dispatch(fork); });
    assert.equal(state.activeId, 'branch');
    assert.equal(state.conversations.length, 2);
    const branch = state.conversations[0];
    assert.equal(branch.messages[0].quote, '引用历史原文', 'forks retain the quoted text independently of source message IDs');
    assert.equal(branch.messages[1].feedback, 'bad', 'forks retain feedback on the copied replies');
    assert.equal(branch.pinned, false);
    assert.deepEqual(branch.messages.map(m => m.content), ['question', 'answer']);
    assert.equal(branch.updatedAt, 42);
    assert.equal(state.conversations[1], source);
    assert.notEqual(branch.messages[0], source.messages[0]);
    const ids = state.conversations.flatMap(c => c.messages.map(m => m.id));
    assert.equal(new Set(ids).size, ids.length);
    await act(async () => { state.dispatch({ type: 'send', conversationId: 'branch', message: { id: 'new-user', role: 'user', content: 'branch only' } }); });
    assert.equal(source.messages.length, 4);
    assert.equal(state.conversations[0].messages.length, 3);
    await act(async () => {
      state.dispatch(fork); // ID collision
      state.dispatch({ ...fork, forkId: 'invalid', messageId: 'missing' });
      state.dispatch({ ...fork, forkId: 'user-target', messageId: 'u1' });
    });
    assert.equal(state.conversations.length, 2);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('model icons preserve theSVG brand colors and Gemini multicolor artwork', () => {
  const icon = (modelId, providerName = '') => renderToStaticMarkup(createElement(ModelIcon, { modelId, providerName }));
  assert.match(icon('claude-sonnet', 'Google gateway'), /#D97757/i, 'model identity takes precedence over the gateway');
  assert.match(icon('deepseek-chat'), /#4D6BFE/i);
  assert.match(icon('mistral-large'), /#FF8205/i);
  const gemini = parseHTML(icon('gemini-pro')).document;
  const fills = new Set([...gemini.querySelectorAll('[fill]')].map((element) => element.getAttribute('fill')).filter((fill) => fill.startsWith('#')));
  assert.ok(fills.size >= 4, 'Gemini retains its authored multicolor artwork');
  assert.ok(gemini.querySelector('mask'), 'Gemini retains its source SVG mask');
  assert.ok(!icon('gpt-4.1').includes('M9 1v4'), 'OpenAI models have a brand icon instead of the generic chip');
  assert.match(icon('custom-model', 'DeepSeek'), /#4D6BFE/i, 'provider identity is used for unrecognized model names');
});
