import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { AppErrorBoundary } from '../src/components/web/app-error-boundary.web.tsx';

function Boom() {
  throw new Error('boom');
}

test('a render error becomes a reload panel and clears on the next route', async () => {
  const previous = { window: globalThis.window, document: globalThis.document,
    HTMLElement: globalThis.HTMLElement, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args); };
  try {
    const root = createRoot(document.getElementById('root'));
    try {
      await act(async () => root.render(createElement(AppErrorBoundary, { resetKey: '/a' }, createElement(Boom))));
      assert.match(document.body.textContent, /界面出错了/);
      assert.match(document.body.textContent, /boom/);
      assert.equal(document.querySelectorAll('.app-error').length, 1);
      assert(logged.length > 0, 'the failure is reported to the console');

      // A different route gets a fresh attempt instead of staying on the panel forever.
      await act(async () => root.render(createElement(AppErrorBoundary, { resetKey: '/b' },
        createElement('p', null, 'recovered'))));
      assert.match(document.body.textContent, /recovered/);
      assert.equal(document.querySelectorAll('.app-error').length, 0);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    console.error = originalError;
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
