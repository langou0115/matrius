import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { MessageContent } from '../src/features/chat/components/message-content.web.tsx';
import { CodeBlock } from '../src/features/chat/components/code-block.web.tsx';
import { normalizeMarkdown } from '../src/features/chat/markdown/normalize-markdown.ts';
import { highlightCode } from '../src/features/chat/markdown/highlight-code.web.ts';
import { createDemoWorkspace } from '../dev/fixtures/chat-workspace.ts';

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

test('math renders fractions, matrices and both provider delimiter styles', () => {
  for (const content of ['$3.14159$', '$E=mc^2$', '$\\frac{1}{2}$', '$$\\sqrt{x^2}$$', '\\(x_i^2\\)', '\\[\\sum_{n=1}^{10} n\\]', '$$\n\\begin{bmatrix}1 & 0 \\\\ 0 & 1\\end{bmatrix}\n$$']) {
    const doc = documentFor(content);
    assert.ok(doc.querySelector('.katex'), content);
    assert.equal(doc.querySelector('.katex-error'), null, content);
    assert.ok(doc.querySelector('math'), 'accessible MathML');
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
      if (conversation.id !== 'dev-render-partial') assert.ok(!html.includes('class="katex-error"'), conversation.id);
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
  const { ConversationSelect } = await import('../src/features/chat/components/conversation-select.web.tsx');
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
  const { MessageActions } = await import('../src/features/chat/components/message-actions.web.tsx');
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
  const click = async (name) => { await act(async () => { document.querySelector(`button[aria-label="${name}"]`).click(); }); };
  const pressed = (name) => document.querySelector(`button[aria-label="${name}"]`).getAttribute('aria-pressed');
  try {
    await act(async () => { root.render(createElement(MessageActions, { message, onFork: () => forks++ })); });
    assert.equal(document.querySelectorAll('button').length, 4);
    await click('复制消息');
    assert.equal(copied, message.content);
    await click('赞');
    assert.equal(pressed('赞'), 'true');
    assert.equal(pressed('踩'), 'false');
    await click('踩');
    assert.equal(pressed('赞'), 'false');
    assert.equal(pressed('踩'), 'true');
    await click('踩');
    assert.equal(pressed('踩'), 'false');
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
    { id: 'u1', role: 'user', content: 'question' },
    { id: 'a1', role: 'assistant', content: 'answer' },
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
