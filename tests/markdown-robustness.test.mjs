import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { parseHTML } from 'linkedom';

import { MessageContent } from '../src/features/chat/components/message-content.web.tsx';
import { createDemoWorkspace } from '../dev/fixtures/chat-workspace.ts';

const render = (content) => renderToStaticMarkup(createElement(MessageContent, { content }));
/** The same reply while it is still arriving. Visually identical; only the failure log differs. */
const renderLive = (content) => renderToStaticMarkup(createElement(MessageContent, { content, streaming: true }));

/**
 * The complaint this whole file exists for, stated as a test: LaTeX showing up as raw source
 * instead of as a formula. So it reads the rendered document the way a person does — fenced code
 * and inline code hold LaTeX on purpose, and KaTeX's own markup is the formula — and reports any
 * backslash command left over in the text that is neither.
 */
export function visibleLatex(content) {
  const doc = parseHTML(render(content)).document;
  const found = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      const hits = (node.textContent ?? '').match(/\\[a-zA-Z]{2,}|\\(?:begin|end)\{/g);
      if (hits) found.push(...hits);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'code' || tag === 'pre' || /katex/.test(node.getAttribute('class') ?? '')) return;
    for (const child of node.childNodes) walk(child);
  };
  walk(doc.documentElement);
  return [...new Set(found)];
}

// Real provider output, well-formed and malformed. The point is not any one fragment but every
// order they arrive in: a single unpaired `$` used to be enough for remark-math to pair it with a
// `$` far down the reply and hand everything in between to KaTeX as one formula, which came back
// as a wall of red error text.
const FRAGMENTS = {
  inline: '行内 $x^2$ 与 $\\frac{1}{2}$。',
  display: '$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$',
  bareEnvironment: '\\begin{cases} y = x \\\\ y = x^2 \\end{cases} \\implies x^2 - x = 0',
  bareMultiline: '\\begin{aligned}\nx &= 1 \\\\\n&= 2\n\\end{aligned}',
  strayDisplayPair: '$$\n\\begin{cases} y = x \\end{cases}\n\n**标题：**\n正文 $X$-型。\n$$',
  unclosedDisplay: '推导：\n\n$$\n\\frac{1}{2}',
  unclosedInline: '计算 $x^2 + y^2',
  threeDelimiters: '$$a$$ 和 $b$ 和 $$c',
  stackedDelimiters: '$$\n$$\n\\frac{1}{2}\n$$\n$$',
  unfinishedEnvironment: '\\begin{aligned}\nx &= 1',
  prose: '这是一段纯中文的说明文字，用于检验排列效果。',
  bold: '**重点内容：**',
  list: '- 第一项\n- 第二项',
  heading: '#### 四级标题',
  fenced: '```ts\nconst x = 1;\n```',
  inlineCode: '写作 `\\frac{1}{2}`。',
  currency: '价格 $20 和 $1,000。',
};
const NAMES = Object.keys(FRAGMENTS);

test('no arrangement of well-formed and malformed fragments reaches KaTeX as a failed formula', () => {
  const failures = [];
  const check = (...keys) => {
    if (render(keys.map((key) => FRAGMENTS[key]).join('\n\n')).includes('katex-source')) failures.push(keys.join(' + '));
  };
  for (const a of NAMES) check(a);
  for (const a of NAMES) for (const b of NAMES) check(a, b);
  // The full triple space is 4913 renders; stepping through it keeps the suite quick.
  for (let i = 0; i < NAMES.length; i += 1)
    for (let j = 0; j < NAMES.length; j += 1)
      for (let k = 0; k < NAMES.length; k += 1) if ((i + j + k) % 5 === 0) check(NAMES[i], NAMES[j], NAMES[k]);
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} arrangements failed`);
});

test('a formula the renderer cannot parse keeps its source but loses the alarm styling', () => {
  // KaTeX stamps `color:#cc0000` on the span it fails with, inline, so no stylesheet rule can
  // soften it. The rehype pass replaces the class and drops the inline style together.
  const html = render('公式 $x^$ 结束。');
  assert.ok(html.includes('katex-source'), 'the source is kept');
  assert.ok(!html.includes('katex-error') && !html.includes('#cc0000'), 'the alarm styling is gone');
  assert.match(render('公式 $x^2$ 结束。'), /class="katex"/, 'a valid formula is untouched');
});

test('a formula that is still broken once the reply is complete says why', () => {
  // The soft landing must not also be a silent one: a reply that streams and then stops is
  // indistinguishable from one that finished, so the reason has to survive into the DOM. It is
  // carried as a data attribute because the reader must not see it — a formula still being written
  // and a formula the normalizer failed to recognise look identical on screen, and only the log
  // can tell them apart.
  const broken = '推导如下：\n\n$$\n\\frac{1}{2} + \\left(\n$$';
  const settled = parseHTML(render(broken)).document.querySelector('.katex-source');
  assert.ok(settled, 'the source is kept');
  assert.match(settled.getAttribute('data-formula-error') ?? '', /KaTeX parse error/, 'the reason is kept');
  assert.equal(settled.getAttribute('class'), 'katex-source', 'the alarm styling is not');
  // Streaming the same text renders the same element: the flag is diagnostic only.
  const live = parseHTML(renderLive(broken)).document.querySelector('.katex-source');
  assert.equal(live?.getAttribute('class'), settled.getAttribute('class'));
});

test('every prefix of a streamed reply stays readable', () => {
  // A reply arrives character by character, so a formula that is not yet valid LaTeX is the normal
  // state rather than an edge case: `x^` has not been given its exponent, `\frac{1}{2` its closing
  // brace. Two things must hold at every one of those moments — no alarm styling, and no unfinished
  // formula swallowing the headings and prose around it.
  const ids = ['dev-render-math', 'dev-render-bare-latex', 'dev-render-stray-delimiter', 'dev-render-markdown'];
  // Markers that are complete long before the end of their reply, with the element each must have
  // become by the time the prefix has carried them. A formula that swallowed the prose takes them
  // with it, which is exactly the failure this guards against.
  const markers = [['**求交点：**', '<strong'], ['**选择积分次序并限定：**', '<strong'], ['#### 【示例 1：直角坐标系】', '<h4']];
  for (const conversation of createDemoWorkspace().chat.conversations) {
    if (!ids.includes(conversation.id)) continue;
    for (const message of conversation.messages.filter((item) => item.role === 'assistant')) {
      for (let length = 1; length <= message.content.length; length += 5) {
        const where = `${conversation.id} @${length}`;
        const prefix = message.content.slice(0, length);
        const html = renderLive(prefix);
        assert.ok(!html.includes('katex-error'), where);
        for (const [marker, element] of markers) {
          if (prefix.includes(marker)) assert.ok(html.includes(element), `${where}: ${marker} was swallowed`);
        }
      }
    }
  }
});

// Everything below is a reply that arrived in a report as a screen of raw LaTeX: the model wrote
// the formula, nothing recognised it as one, and markdown handed the backslashes through as text.
// The commands are the ones the report named, each in the shape it arrived in.
const REPORTED_SHAPES = {
  'fraction in a sentence': '所以结果是 \\frac{1}{2}。',
  'double integral with a subscript': '于是 \\iint_D xy \\, dxdy = \\frac{1}{24}。',
  'implication with no braces': '由 $x^2 = x$ 得 \\implies x(x - 1) = 0。',
  'definite integral': '即 \\int_0^1 x^2\\,dx = \\frac{1}{3}。',
  'cases environment': '所以 \\begin{cases} y = x \\\\ y = x^2 \\end{cases} 成立。',
  'aligned environment': '推导如下：\n\\begin{aligned}\nx &= 1 \\\\\n&= 2\n\\end{aligned}',
  'sum with limits': '求 \\sum_{n=1}^{\\infty} \\frac{1}{n^2} 的值。',
  'greek letter alone': '记这个角为 \\alpha。',
  'matrix without delimiters': '矩阵 \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} 可逆。',
};

test('a formula a model wrote without delimiters is never shown as source', () => {
  for (const [name, content] of Object.entries(REPORTED_SHAPES)) assert.deepEqual(visibleLatex(content), [], name);
  for (const [name, content] of Object.entries(REPORTED_SHAPES)) {
    assert.ok(parseHTML(render(content)).document.querySelector('.katex'), `${name} renders as math`);
  }
});

test('a display block the model closed with one $ instead of two still renders as one display block', () => {
  // The shape the first screenshot arrived in: `$$` opens, a single `$` closes. The stray `$` is
  // the closer, not a formula character, and leaving it inside the body is what made KaTeX report
  // `Can't use function '$' in math mode`.
  const content = '列式并计算：\n\n$$\n\\begin{aligned}\n\\iint_D xy \\, dxdy &= \\int_0^1 dx \\int_{x^2}^x xy \\, dy \\\\\n&= \\frac{1}{24}\n\\end{aligned}$';
  const doc = parseHTML(render(content)).document;
  assert.ok(doc.querySelector('.katex-display'), 'renders as a display block');
  assert.equal(doc.querySelector('.katex-source'), null);
  assert.match(doc.querySelector('.message-markdown').textContent, /列式并计算/);
});

test('markdown and math survive together in one reply', () => {
  const content = [
    '#### 【示例 1：直角坐标系】',
    '',
    '**选择积分次序并限定：**',
    '',
    '1. 求交点：$y = x^2$ 与 $y = x$ 交于 $x = 0$ 和 $x = 1$',
    '2. 更换次序，先对 $y$ 后对 $x$ 积分',
    '',
    '$$',
    '\\begin{cases}',
    '\\iint_D xy \\, dxdy = \\int_0^1 dx \\int_{x^2}^x xy \\, dy, & D \\text{ 由 } y = x^2 \\text{ 与 } y = x \\text{ 围成} \\\\',
    '\\frac{1}{24}, & \\text{其余情形}',
    '\\end{cases}',
    '$$',
    '',
    '约去公因式后得 $\\frac{\\pi^2}{6}$。',
  ].join('\n');
  const doc = parseHTML(render(content)).document;
  for (const tag of ['h4', 'strong', 'ol', 'li']) assert.ok(doc.querySelector(tag), tag);
  assert.ok(doc.querySelectorAll('.katex-display').length >= 1, 'a display formula');
  assert.ok(doc.querySelectorAll('.katex').length >= 3, 'the inline formulas');
  assert.deepEqual(visibleLatex(content), []);
});

test('LaTeX inside a fence is left exactly as the author wrote it', () => {
  const source = '\\frac{1}{2} 与 \\begin{cases} y = x \\end{cases}';
  const content = `\`\`\`latex\n${source}\n\`\`\`\n\n正文 $x^2$。`;
  const doc = parseHTML(render(content)).document;
  assert.equal(doc.querySelector('code').textContent, source);
  assert.equal(doc.querySelectorAll('.katex-display').length, 0);
  assert.equal(doc.querySelectorAll('.katex').length, 1);
});

test('money, file paths and escaped characters are not mistaken for formulas', () => {
  for (const content of ['价格 $20 和 $1,000。', '路径 C:\\Users\\name 下。', '写作 `\\alpha` 表示这个角。']) {
    const doc = parseHTML(render(content)).document;
    assert.equal(doc.querySelector('.katex'), null, content);
    assert.equal(doc.querySelector('.katex-source'), null, content);
    assert.equal(doc.querySelector('code')?.textContent ?? '', content.includes('`') ? '\\alpha' : '');
  }
  assert.match(parseHTML(render('价格 $20 和 $1,000。')).document.querySelector('.message-markdown').textContent, /\$1,000/);
});

test('no reply the demo workspace ships with shows LaTeX as text', () => {
  // `dev-render-partial` is the one exception, and it is deliberate: it holds a formula cut off
  // mid-stream, which has no correct rendering until the reply that completes it arrives.
  for (const conversation of createDemoWorkspace().chat.conversations) {
    if (conversation.id === 'dev-render-partial') continue;
    for (const message of conversation.messages.filter((item) => item.role === 'assistant')) {
      assert.deepEqual(visibleLatex(message.content), [], `${conversation.id} @${message.id}`);
    }
  }
});
