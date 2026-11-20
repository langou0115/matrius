import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { Workspace } from '../ui/components/web/workspace.tsx';
import { ChatProvider } from '../ui/features/chat/chat-state.tsx';
import { ChatRuntimeProvider } from '../ui/features/chat/chat-runtime.tsx';
import { resetSidebarTabForTests } from '../ui/features/chat/sidebar-mode.ts';
import { Sidebar } from '../ui/features/chat/components/sidebar.tsx';
import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { ModelProvider } from '../ui/features/models/model-state.tsx';
import { MemoryProvider } from '../ui/features/memory/memory-state.tsx';
import { NetworkToolsProvider } from '../ui/features/instance/network-tools-state.tsx';
import { PersonalizationProvider } from '../ui/features/settings/personalization-state.tsx';
import { AppearanceProvider } from '../ui/theme/appearance.tsx';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';

function setupDom({ mobile = false, target = 'web' } = {}) {
  resetSidebarTabForTests();
  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    dev: globalThis.__DEV__,
    target: globalThis.__MATRIUS_TARGET__,
  };

  window.matchMedia = (query) => ({
    matches: query === '(max-width: 767px)' ? mobile : false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__DEV__ = true;
  globalThis.__MATRIUS_TARGET__ = target;

  return {
    window,
    document,
    restore() {
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.Event = previous.Event;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
      globalThis.__DEV__ = previous.dev;
      globalThis.__MATRIUS_TARGET__ = previous.target;
    },
  };
}

function renderSidebarTree(withWorkspace = false) {
  const content = withWorkspace
    ? createElement(Workspace, null, createElement('div', { className: 'chat-placeholder' }, '聊天正文区域'))
    : createElement(Sidebar, { onSearch: () => {}, collapsed: false });
  return createElement(
    AppearanceProvider,
    null,
    createElement(
      InstanceProvider,
      { preview: true },
      createElement(
        PreviewContext.Provider,
        { value: true },
        createElement(
          ModelProvider,
          { preview: true },
          createElement(
            PersonalizationProvider,
            null,
            createElement(
              MemoryProvider,
              null,
              createElement(
                NetworkToolsProvider,
                null,
                createElement(
                  ChatProvider,
                  {
                    initialState: {
                      conversations: [
                        { id: 'c1', title: '测试对话', pinned: false, updatedAt: 1, messages: [] },
                      ],
                      activeId: null,
                      sidebarOpen: true,
                    },
                  },
                  createElement(
                    ChatRuntimeProvider,
                    null,
                    content,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

test('web target omits 工作/对话 switcher on desktop viewport and renders chat navigation directly', async () => {
  const dom = setupDom({ mobile: false, target: 'web' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree());
    });

    const sidebar = dom.document.querySelector('aside.sidebar');
    assert.ok(sidebar);
    assert.equal(sidebar.querySelector('.sidebar-mode-switch'), null);
    assert.equal(sidebar.querySelector('#sidebar-panel-work'), null);
    assert.ok(sidebar.querySelector('.sidebar-primary'));
    assert.match(sidebar.textContent ?? '', /新对话/);
    assert.match(sidebar.textContent ?? '', /测试对话/);
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});

test('desktop target renders 工作 and 对话 switcher above 新对话, with work projects panel', async () => {
  const dom = setupDom({ mobile: false, target: 'desktop' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree());
    });

    const sidebar = dom.document.querySelector('aside.sidebar');
    assert.ok(sidebar);

    const tabs = Array.from(sidebar.querySelectorAll('.sidebar-mode-switch [role="tab"]'));
    assert.deepEqual(tabs.map((tab) => tab.textContent?.trim()), ['工作', '对话']);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');

    // Switcher sits directly above 新对话 (before .sidebar-chat-panel / .sidebar-primary).
    const children = Array.from(sidebar.children);
    const switchIndex = children.findIndex((el) => el.classList.contains('sidebar-mode-switch'));
    const chatPanelIndex = children.findIndex((el) => el.classList.contains('sidebar-chat-panel'));
    assert.ok(switchIndex >= 0 && chatPanelIndex === switchIndex + 1);
    assert.ok(sidebar.querySelector('.sidebar-primary'));
    assert.match(sidebar.textContent ?? '', /新对话/);
    assert.match(sidebar.textContent ?? '', /测试对话/);

    // Clicking 工作 hides chat nav/history and renders work projects navigation.
    await act(async () => {
      tabs[0].click();
    });
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
    const workPanel = sidebar.querySelector('#sidebar-panel-work');
    assert.ok(workPanel);
    assert.match(workPanel.textContent ?? '', /创建项目/);
    assert.match(workPanel.textContent ?? '', /项目/);
    assert.doesNotMatch(sidebar.textContent ?? '', /新对话/);
    assert.doesNotMatch(sidebar.textContent ?? '', /测试对话/);
    assert.ok(sidebar.querySelector('.sidebar-settings-entry'));

    // Unmounting Sidebar (e.g. entering Settings) and remounting preserves the active 工作 tab.
    await act(async () => { root.unmount(); });
    const remounted = createRoot(dom.document.getElementById('root'));
    await act(async () => {
      remounted.render(renderSidebarTree());
    });
    const remountedSidebar = dom.document.querySelector('aside.sidebar');
    assert.ok(remountedSidebar.querySelector('#sidebar-panel-work'));
    assert.doesNotMatch(remountedSidebar.textContent ?? '', /新对话/);
    const remountedTabs = Array.from(remountedSidebar.querySelectorAll('.sidebar-mode-switch [role="tab"]'));
    assert.equal(remountedTabs[0].getAttribute('aria-selected'), 'true');

    // Keyboard ArrowRight switches back to 对话 and shows 新对话 + history again.
    const tablist = remountedSidebar.querySelector('.sidebar-mode-switch');
    const propsKey = Object.keys(tablist).find((key) => key.startsWith('__reactProps'));
    assert.ok(propsKey);
    await act(async () => {
      tablist[propsKey].onKeyDown({ key: 'ArrowRight', preventDefault() {} });
    });
    assert.equal(remountedTabs[1].getAttribute('aria-selected'), 'true');
    assert.ok(remountedSidebar.querySelector('.sidebar-primary'));
    assert.match(remountedSidebar.textContent ?? '', /新对话/);
    assert.match(remountedSidebar.textContent ?? '', /测试对话/);
    await act(async () => { remounted.unmount(); });
  } finally {
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('desktop target on mobile viewport omits 工作/对话 switcher and renders chat navigation directly', async () => {
  const dom = setupDom({ mobile: true, target: 'desktop' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree());
    });

    const sidebar = dom.document.querySelector('aside.sidebar');
    assert.ok(sidebar);
    assert.equal(sidebar.querySelector('.sidebar-mode-switch'), null);
    assert.ok(sidebar.querySelector('.sidebar-primary'));
    assert.match(sidebar.textContent ?? '', /新对话/);
    assert.match(sidebar.textContent ?? '', /测试对话/);
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});

test('desktop workspace clears the right conversation area when switching to 工作 and keeps expand control when collapsed', async () => {
  const dom = setupDom({ mobile: false, target: 'desktop' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree(true));
    });

    assert.ok(dom.document.querySelector('.chat-placeholder'));
    assert.equal(dom.document.querySelector('main.work-main'), null);

    const workTab = dom.document.querySelector('#sidebar-tab-work');
    assert.ok(workTab);
    await act(async () => { workTab.click(); });

    assert.equal(dom.document.querySelector('.chat-placeholder'), null);
    const workMain = dom.document.querySelector('main.work-main');
    assert.ok(workMain);
    assert.equal(workMain.children.length, 0);

    // Collapsing the sidebar on 工作 still exposes the expand trigger so the user can reopen it.
    const collapseBtn = dom.document.querySelector('button[aria-label="收起侧栏"]');
    assert.ok(collapseBtn);
    await act(async () => { collapseBtn.click(); });
    const expandBtn = dom.document.querySelector('main.work-main .sidebar-expand');
    assert.ok(expandBtn);

    await act(async () => { expandBtn.click(); });
    assert.equal(dom.document.querySelector('main.work-main .sidebar-expand'), null);

    // Switching back to 对话 restores the right conversation content.
    const chatTab = dom.document.querySelector('#sidebar-tab-chat');
    assert.ok(chatTab);
    await act(async () => { chatTab.click(); });
    assert.ok(dom.document.querySelector('.chat-placeholder'));
    assert.equal(dom.document.querySelector('main.work-main'), null);
  } finally {
    await act(async () => { root.unmount(); });
    resetSidebarTabForTests();
    dom.restore();
  }
});
