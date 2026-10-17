import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { transform } from 'lightningcss';
import { parseHTML } from 'linkedom';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { MessageContent } from '../src/features/chat/components/message-content.web.tsx';

/**
 * Inline math alignment, pinned at the two layers a browser actually consults.
 *
 * The failure this guards against was made in CSS, not markup: giving `.katex` an `overflow` other
 * than `visible` turns it into a box whose baseline is its own bottom margin edge (CSS 2.1
 * §10.8.1), which lifts the formula above the Chinese text beside it by its full depth. So the
 * stylesheet is read back and checked for every declaration that can move a baseline, and the
 * markup is checked to be the inline shape those rules assume.
 */
const render = (content) => renderToStaticMarkup(createElement(MessageContent, { content }));

const doc = (content) => parseHTML(render(content)).document;

const EXAMPLE = '性质：满足交换律 \\(A+B=B+A\\) 和结合律 \\((A+B)+C=A+(B+C)\\)。';

test('an inline formula is an inline box inside the sentence it belongs to', () => {
  const page = doc(EXAMPLE);
  const paragraphs = page.querySelectorAll('p');
  assert.equal(paragraphs.length, 1, 'the sentence stays one paragraph');
  assert.equal(page.querySelectorAll('.katex-display').length, 0, 'nothing was promoted to a block');

  const formulas = page.querySelectorAll('.katex');
  assert.equal(formulas.length, 2, 'both formulas render');
  for (const formula of formulas) {
    assert.equal(formula.tagName, 'SPAN', 'KaTeX emits an inline-level span');
    assert.equal(formula.parentElement, paragraphs[0], 'and it sits directly in the sentence');
  }
  assert.match(paragraphs[0].textContent, /性质：满足交换律/, 'the prose is still there');
});

test('formulas stay inline in lists, tables and bold text', () => {
  // The rules above are unscoped, so every context inherits the same inline treatment. This pins
  // that they are not accidentally promoted anywhere a block wrapper could appear.
  const content = [
    '1. 列表项 $a+b=b+a$',
    '',
    '| 名称 | 式子 |',
    '| --- | --- |',
    '| 交换律 | $(a+b)+c=a+(b+c)$ |',
    '',
    '**加粗 $x^2$ 结尾**',
  ].join('\n');
  const page = doc(content);
  assert.equal(page.querySelectorAll('.katex-display').length, 0, 'nothing is promoted to a block');
  assert.ok(page.querySelector('li .katex'), 'in a list item');
  assert.ok(page.querySelector('td .katex'), 'in a table cell');
  assert.ok(page.querySelector('strong .katex'), 'inside bold text');
  for (const formula of page.querySelectorAll('.katex')) assert.equal(formula.tagName, 'SPAN');
});

test('the stylesheet leaves the inline baseline to KaTeX', () => {
  const { code } = transform({ filename: 'global.css', code: readFileSync('src/global.css'), errorRecovery: false });
  const css = code.toString();
  const declarations = (selector) => {
    const rule = css.match(new RegExp(`${selector.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`));
    assert.ok(rule, `${selector} is missing from global.css`);
    return Object.fromEntries(rule[1].split(';').filter(Boolean).map((part) => {
      const [property, ...rest] = part.split(':');
      return [property.trim(), rest.join(':').trim()];
    }));
  };

  const inline = declarations('.message-markdown .katex');
  // Each of these either changes the baseline directly or forces the browser to substitute one.
  for (const property of ['display', 'overflow', 'overflow-x', 'overflow-y', 'vertical-align',
    'position', 'top', 'bottom', 'transform', 'translate', 'height', 'line-height', 'margin', 'padding']) {
    assert.equal(inline[property], undefined, `.message-markdown .katex must not set ${property}`);
  }
  assert.ok(inline['font-size'], 'it may still scale the formula');

  // The block case keeps its own scroll container, which cannot affect a line box.
  const display = declarations('.message-markdown .katex-display');
  assert.equal(display['overflow-x'] ?? display.overflow?.split(/\s+/)[0], 'auto');
  assert.equal(display['max-width'], '100%');

  // The prose block must not clip: a scroll container here would shave the bottom off a fraction,
  // which draws a couple of pixels below its line box. Wrapping, not clipping, is the fallback.
  assert.equal(declarations('.message-markdown').overflow, undefined);
});
