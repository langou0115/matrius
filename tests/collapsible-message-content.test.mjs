import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { parseHTML } from 'linkedom';

test('user message bubbles render Markdown and LaTeX syntax as literal plain text', async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    ResizeObserver: globalThis.ResizeObserver,
  };

  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let scrollHeightValue = 80;
  let clientHeightValue = 80;
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return scrollHeightValue; },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return clientHeightValue; },
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { CollapsibleMessageContent } = await import('../ui/features/chat/components/collapsible-message-content.tsx');

  const rawPrompt = [
    '# 不是标题',
    '**不是加粗** `不是行内代码` [链接](https://example.com)',
    '- 列表项',
    '$x^2 + y^2$',
    '<b>不是HTML标签</b>',
  ].join('\n');

  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => {
      root.render(createElement(CollapsibleMessageContent, { content: rawPrompt }));
    });

    const body = document.querySelector('.collapsible-message-body');
    assert.ok(body);
    assert.equal(body.textContent, rawPrompt);
    assert.equal(document.querySelector('.message-markdown'), null);
    assert.equal(body.querySelector('h1, strong, code, a, ul, li, b, .katex'), null);
    assert.equal(document.querySelector('.collapsible-message-toggle'), null);

    scrollHeightValue = 320;
    clientHeightValue = 200;
    await act(async () => {
      root.render(createElement(CollapsibleMessageContent, { content: `${rawPrompt}\n更多内容` }));
    });
    const toggle = document.querySelector('.collapsible-message-toggle');
    assert.ok(toggle);
    assert.match(toggle.textContent ?? '', /展开/);
    await act(async () => { toggle.click(); });
    assert.match(document.querySelector('.collapsible-message-toggle')?.textContent ?? '', /收起/);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    globalThis.ResizeObserver = previous.ResizeObserver;
  }
});
