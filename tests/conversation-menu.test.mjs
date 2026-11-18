import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ConversationMenu } from '../ui/features/chat/components/conversation-menu.tsx';

test('ConversationMenu ignores scroll events outside the sidebar list and closes when its ancestor scrolls', async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    Node: globalThis.Node,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };

  const { window, document } = parseHTML(
    '<!doctype html><html><body><div class="conversation-list"><button id="anchor" type="button">...</button></div><div class="messages-scroll"></div><div id="menu-root"></div></body></html>',
  );
  const scrollHandlers = new Set();
  const originalAdd = window.addEventListener.bind(window);
  const originalRemove = window.removeEventListener.bind(window);
  window.addEventListener = (type, listener, options) => {
    if (type === 'scroll' && typeof listener === 'function') scrollHandlers.add(listener);
    return originalAdd(type, listener, options);
  };
  window.removeEventListener = (type, listener, options) => {
    if (type === 'scroll' && typeof listener === 'function') scrollHandlers.delete(listener);
    return originalRemove(type, listener, options);
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.Node = window.Node;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const anchor = document.getElementById('anchor');
  const list = document.querySelector('.conversation-list');
  const messagesScroll = document.querySelector('.messages-scroll');
  const menuRoot = document.getElementById('menu-root');
  const root = createRoot(menuRoot);
  let closed = 0;

  try {
    await act(async () => {
      root.render(createElement(ConversationMenu, {
        conversation: { id: 'c1', title: '测试对话', pinned: false, messages: [], updatedAt: 1 },
        anchor,
        onClose: () => { closed += 1; },
        onPin: () => {},
        onRename: () => {},
        onDelete: () => {},
      }));
    });

    assert.ok(document.getElementById('conversation-menu'));
    assert.equal(scrollHandlers.size, 1);

    // Auto-scroll in the chat message pane must not dismiss the sidebar menu.
    await act(async () => {
      for (const handler of scrollHandlers) handler({ target: messagesScroll });
    });
    assert.equal(closed, 0);

    // Scrolling the sidebar list itself (an ancestor of the anchor) closes the menu.
    await act(async () => {
      for (const handler of scrollHandlers) handler({ target: list });
    });
    assert.equal(closed, 1);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.Node = previous.Node;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
