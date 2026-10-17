import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, useRef, act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { useChatAutoScroll } from '../src/features/chat/components/scroll-to-bottom.web.tsx';

/**
 * The button is meant for "I scrolled back to read something", not for "the page moved one line".
 *
 * Following stops at a small distance from the end, because that is what the reader meant when
 * they nudged the wheel. Visibility used to share that same threshold and therefore appeared after
 * roughly a tenth of a viewport. These assertions pin the two decisions apart: a partial nudge
 * stops the follow but must not summon the button.
 */
test('the jump button waits until the newest message is well out of view', async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.getElementById('root'));
  let visible = false;

  function Harness() {
    const ref = useRef(null);
    visible = useChatAutoScroll({ containerRef: ref, containerKey: 'chat', followKey: 'messages' }).visible;
    return createElement('div', { ref, id: 'scroller' });
  }

  const scroll = (scrollTop) => act(async () => {
    scroller.scrollTop = scrollTop;
    scroller.dispatchEvent(new window.Event('scroll'));
  });

  let scroller;
  try {
    await act(async () => { root.render(createElement(Harness)); });
    scroller = document.getElementById('scroller');
    const viewport = 800;
    const content = 4000;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: viewport },
      scrollHeight: { configurable: true, value: content },
      scrollTop: { configurable: true, writable: true, value: content - viewport },
      scrollTo: { configurable: true, value: ({ top }) => { scroller.scrollTop = top; } },
    });

    // Sitting at the end: nothing to jump to.
    await scroll(content - viewport);
    assert.equal(visible, false, 'at the bottom');

    // A small nudge is enough to stop auto-following, but the latest message is still on screen.
    await scroll(content - viewport - Math.round(viewport * 0.12));
    assert.equal(visible, false, 'a small nudge must not show the button');

    // Even most of a screen away is still within reach of a glance downward.
    await scroll(content - viewport - Math.round(viewport * 0.62));
    assert.equal(visible, false, 'a partial scroll must not show the button');
    await scroll(content - viewport - Math.round(viewport * 0.95));
    assert.equal(visible, false, 'even a nearly full screen must not show the button');

    // Only once the newest message is more than a full screen away is the jump worth offering.
    await scroll(content - viewport - Math.round(viewport * 1.25));
    assert.equal(visible, true, 'the button appears once the bottom is out of reach');

    // Returning to the end hides it again.
    await scroll(content - viewport - 20);
    assert.equal(visible, false, 'back at the bottom');
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
