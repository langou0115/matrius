import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { Dialog } from '../ui/components/web/dialog.tsx';

test('dragging a text selection out of the panel does not close the dialog', async () => {
  const previous = { window: globalThis.window, document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT, HTMLElement: globalThis.HTMLElement };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  let closed = 0;
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(createElement(Dialog, { title: '登录', onClose: () => { closed += 1; } },
      createElement('input', { defaultValue: 'selected text' }))));
    const dialog = document.querySelector('dialog');
    const input = document.querySelector('input');

    // Pressing inside the field and releasing on the backdrop must keep the selection.
    await act(async () => {
      input.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      dialog.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    });
    assert.equal(closed, 0);

    // A press that starts and ends on the backdrop still dismisses.
    await act(async () => {
      dialog.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
      dialog.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
    });
    assert.equal(closed, 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
