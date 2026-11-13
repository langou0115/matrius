import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { LibraryItem } from '../ui/features/files/library-item.tsx';

test('mobile long press opens file actions and selection mode uses independent checkboxes', async (t) => {
  const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, right: 300, top: 20, bottom: 80, width: 148, height: 140 });
  window.HTMLElement.prototype.focus = () => {};
  window.innerWidth = 390;
  window.innerHeight = 800;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = createRoot(document.getElementById('root'));
  let selected = false;
  let selecting = false;
  let toggles = 0;
  const render = () => root.render(createElement(LibraryItem, {
    file: { id: 'file', filename: 'sample.pdf', size: 100, createdAt: '', contentType: 'application/pdf' },
    selected, selectable: selecting, mobile: true,
    onToggle: () => { selected = !selected; toggles++; render(); },
    onRename() {}, onDelete() {},
  }));
  const dispatch = (target, type, properties = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { isPrimary: true, button: 0, clientX: 20, clientY: 20, detail: 1 }, properties);
    target.dispatchEvent(event);
  };
  try {
    await act(async () => render());
    const main = document.querySelector('.library-item-main');
    await act(async () => {
      dispatch(main, 'pointerdown');
      dispatch(main, 'pointermove', { clientY: 60 });
      t.mock.timers.tick(500);
      dispatch(main, 'pointercancel');
    });
    assert.equal(document.querySelector('[role="menu"]'), null, 'scrolling cancels the long press');
    await act(async () => { dispatch(main, 'pointerdown'); t.mock.timers.tick(500); });
    assert.equal(selected, false);
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 3);
    assert.equal(document.querySelector('.library-item-actions'), null, 'mobile rows have no more button');
    await act(async () => { dispatch(main, 'pointerup'); dispatch(main, 'click'); });
    assert.equal(selected, false, 'the click after the long press must not select the file');
    await act(async () => dispatch(document.querySelector('[role="menu"]'), 'keydown', { key: 'Escape' }));
    assert.equal(document.querySelector('[role="menu"]'), null);
    selecting = true;
    await act(async () => render());
    const check = document.querySelector('.library-item-check');
    assert.equal(main.contains(check), false, 'the checkbox stays outside the file content button');
    assert.equal(check.parentElement.className, 'library-item-select-control');
    await act(async () => { dispatch(check, 'pointerdown'); dispatch(check, 'pointerup'); dispatch(check, 'click'); });
    assert.equal(selected, true);
    await act(async () => { dispatch(check, 'pointerdown'); dispatch(check, 'pointerup'); dispatch(check, 'click'); });
    assert.equal(selected, false);
    assert.equal(toggles, 2);
    assert.notEqual(document.querySelector('.library-item-check'), null, 'selection mode persists when empty');
    await act(async () => { dispatch(main, 'pointerdown'); t.mock.timers.tick(500); });
    assert.equal(document.querySelectorAll('[role="menuitem"]').length, 3);
    assert.equal(selected, false, 'long pressing in selection mode only opens actions');
  } finally {
    await act(async () => root.unmount());
    t.mock.timers.reset();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
