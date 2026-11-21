import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { ChatProvider } from '../ui/features/chat/chat-state.tsx';
import { SearchDialog } from '../ui/features/chat/components/search-dialog.tsx';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';

function setupDom() {
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };

  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  window.HTMLElement.prototype.focus = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};

  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  return {
    document,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.Event = previous.Event;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

test('SearchDialog initially shows only the search input and reveals matching conversations on input', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(
        createElement(
          PreviewContext.Provider,
          { value: true },
          createElement(
            ChatProvider,
            {
              initialState: {
                conversations: [
                  {
                    id: 'c1',
                    title: 'Alpha 项目架构',
                    pinned: false,
                    updatedAt: 200,
                    messages: [{ id: 'm1', role: 'user', content: '讨论接口设计', status: 'complete' }],
                  },
                  {
                    id: 'c2',
                    title: '日常记录',
                    pinned: false,
                    updatedAt: 100,
                    messages: [{ id: 'm2', role: 'user', content: '买菜清单', status: 'complete' }],
                  },
                ],
                activeId: null,
                sidebarOpen: true,
              },
            },
            createElement(SearchDialog, { onClose: () => {} }),
          ),
        ),
      );
    });

    const input = dom.document.querySelector('.search-input-row input');
    assert.ok(input);
    assert.equal(dom.document.getElementById('conversation-search-results'), null);
    assert.equal(dom.document.querySelectorAll('.search-result').length, 0);

    const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps'));
    assert.ok(propsKey);

    await act(async () => {
      input.value = 'Alpha';
      input[propsKey].onChange({ target: input });
    });

    const resultsBox = dom.document.getElementById('conversation-search-results');
    assert.ok(resultsBox);
    const items = dom.document.querySelectorAll('.search-result');
    assert.equal(items.length, 1);
    assert.match(items[0].textContent ?? '', /Alpha 项目架构/);

    await act(async () => {
      input.value = '不存在的关键词';
      input[propsKey].onChange({ target: input });
    });
    assert.equal(dom.document.querySelectorAll('.search-result').length, 0);
    assert.match(dom.document.querySelector('.search-empty')?.textContent ?? '', /没有找到相关对话/);

    await act(async () => {
      input.value = '   ';
      input[propsKey].onChange({ target: input });
    });
    assert.equal(dom.document.getElementById('conversation-search-results'), null);
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});
