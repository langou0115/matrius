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
import { ModelIcon } from '../src/features/chat/components/model-icon.web.tsx';
import { normalizeMarkdown } from '../src/features/chat/markdown/normalize-markdown.ts';
import { highlightCode } from '../src/features/chat/markdown/highlight-code.web.ts';
import { createDemoWorkspace } from '../dev/fixtures/chat-workspace.ts';
import { ReasoningBlock } from '../src/features/chat/components/reasoning-block.web.tsx';
import { ReplyStatus } from '../src/features/chat/components/reply-status.web.tsx';

test('collapsed thinking stays lightweight and the waiting header remains clickable', () => {
  const reasoning = renderToStaticMarkup(createElement(ReasoningBlock, { state: 'running', reasoning: '**Long thinking transcript**' }));
  assert.ok(!reasoning.includes('Long thinking transcript'), 'collapsed transcripts do not repeatedly parse/render streamed Markdown');
  assert.ok(reasoning.includes('aria-expanded="false"'));
  const waiting = renderToStaticMarkup(createElement(ReasoningBlock, { state: 'running' }));
  assert.ok(waiting.includes('<button'), 'the same thinking header is clickable before the first token');
  assert.ok(waiting.includes('aria-expanded="false"'));

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

test('reasoning keeps all source links inside collapsed tool sections and reports empty searches', () => {
  const results = Array.from({ length: 8 }, (_, rank) => ({
    rank, title: `Source ${rank}`, url: `https://example.com/${rank}`, domain: 'example.com', snippet: '', engine: 'duckduckgo',
  }));
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'complete', open: true, activities: [
      { id: 'full', kind: 'search', status: 'complete', query: 'query', results },
      { id: 'empty', kind: 'search', status: 'complete', query: 'empty', results: [] },
    ],
  })));
  assert.equal(document.querySelectorAll('.web-activity-sources a').length, 8);
  assert.equal(document.querySelector('.web-activity-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelector('.web-activity-details').hidden, true);
  assert.match(document.querySelector('.web-activity-empty').textContent, /未找到可用结果/);
  assert.equal(document.querySelector('.reasoning-toggle').getAttribute('aria-expanded'), 'true');
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
      assert.ok(document.querySelector('.reasoning-text').textContent.includes('已收到的思考'));
      assert.equal(document.querySelector('.reasoning-body').hidden, false);
      assert.equal(document.querySelector('.response-sources'), null);
    }
    await act(async () => { document.querySelector('.reasoning-toggle').click(); });
    assert.equal(document.querySelector('.reasoning-text'), null, 'collapsed text unmounts to avoid streaming Markdown work');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('tool sections follow OpenStudio: active details open, completed details collapse and can be reopened', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  const activity = { id: 'batch', kind: 'fetch', url: 'https://example.com/a', urls: ['https://example.com/a', 'https://example.com/b'] };
  const render = (status) => act(async () => root.render(createElement(ReasoningBlock, { open: true, state: status === 'running' ? 'running' : 'complete', activities: [{ ...activity, status }] })));
  try {
    await render('running');
    assert.equal(document.querySelector('.web-activity-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(document.querySelectorAll('.web-activity-result').length, 2);
    await render('complete');
    assert.equal(document.querySelector('.web-activity-toggle').getAttribute('aria-expanded'), 'false');
    await act(async () => document.querySelector('.web-activity-toggle').click());
    assert.equal(document.querySelector('.web-activity-details').hidden, false);
    await render('complete');
    assert.equal(document.querySelector('.web-activity-details').hidden, false, 'later render does not reset manual expansion');
    await act(async () => document.querySelector('.web-activity-toggle').click());
    assert.equal(document.querySelector('.web-activity-details').hidden, true);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});

test('the process renders separate thinking segments around search and fetch in event order', () => {
  const process = [
    { id: 'first', kind: 'thinking', content: '先搜索', status: 'complete' },
    { id: 'search', kind: 'search', status: 'complete', query: 'Python' },
    { id: 'fetch', kind: 'fetch', status: 'complete', url: 'https://example.com/a' },
    { id: 'second', kind: 'thinking', content: '再分析', status: 'running' },
  ];
  const { document } = parseHTML(renderToStaticMarkup(createElement(ReasoningBlock, {
    state: 'running', open: true, reasoning: 'legacy merged transcript', process,
  })));
  const steps = [...document.querySelector('.reasoning-steps').children];
  assert.equal(steps.length, 4);
  assert.equal(steps[0].textContent, '先搜索');
  assert.ok(steps[1].querySelector('.web-activity'));
  assert.ok(steps[2].querySelector('.web-activity'));
  assert.equal(steps[3].textContent, '再分析');
  assert.ok(!document.body.textContent.includes('legacy merged transcript'));
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
