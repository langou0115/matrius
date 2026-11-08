import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { StorageErrorToast } from '../src/components/web/storage-error-toast.tsx';

test('save errors expose plain text and disappear after five seconds even without a successful save', async (t) => {
  const keys = ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT'];
  const previous = Object.fromEntries(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  for (const [key, value] of Object.entries({ window, document, IS_REACT_ACT_ENVIRONMENT: true,
  })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = createRoot(document.getElementById('root'));
  const message = '最新修改未能保存到云端（422 validation_error）。';
  let refreshes = 0;
  window.location = { reload: () => refreshes++ };
  const render = () => root.render(createElement(StorageErrorToast, { message }));
  try {
    await act(async () => render());
    assert.equal(document.querySelector('.storage-error span').textContent, message);
    assert.equal(document.querySelectorAll('.storage-error button').length, 1);
    const refresh = document.querySelector('.storage-error button');
    assert.equal(refresh.getAttribute('aria-label'), '刷新页面');
    assert.ok(refresh.querySelector('svg'));
    assert.equal(refresh.textContent.trim(), '');
    await act(async () => refresh.dispatchEvent(new window.Event('click', { bubbles: true })));
    assert.equal(refreshes, 1);
    await act(async () => t.mock.timers.tick(4999));
    assert.ok(document.querySelector('.storage-error'));
    await act(async () => render()); // Repeated saves of the same error must not restart the timer.
    await act(async () => t.mock.timers.tick(1));
    assert.equal(document.querySelector('.storage-error'), null);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
