import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { Workspace } from '../ui/components/web/workspace.tsx';
import { ChatProvider } from '../ui/features/chat/chat-state.tsx';
import { ChatRuntimeProvider } from '../ui/features/chat/chat-runtime.tsx';
import { resetSidebarTabForTests } from '../ui/features/chat/sidebar-mode.ts';
import { Sidebar, resetLastCollapsedDrawerTabForTests } from '../ui/features/chat/components/sidebar.tsx';
import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { ModelProvider } from '../ui/features/models/model-state.tsx';
import { MemoryProvider } from '../ui/features/memory/memory-state.tsx';
import { NetworkToolsProvider } from '../ui/features/instance/network-tools-state.tsx';
import { PersonalizationProvider } from '../ui/features/settings/personalization-state.tsx';
import { AppearanceProvider } from '../ui/theme/appearance.tsx';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';

function setupDom({ mobile = false, target = 'web' } = {}) {
  resetSidebarTabForTests();
  resetLastCollapsedDrawerTabForTests();
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

test('web target renders persistent Activity Rail (chat/library/tasks, no project) and chat drawer with only 新对话 + groups', async () => {
  const dom = setupDom({ mobile: false, target: 'web' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree(true));
    });

    const rail = dom.document.querySelector('nav.sidebar-rail');
    assert.ok(rail);
    assert.ok(rail.querySelector('button[aria-label="对话"]'));
    assert.ok(rail.querySelector('a[aria-label="打开资料库"]'));
    assert.ok(rail.querySelector('a[aria-label="打开定时任务"]'));
    assert.equal(rail.querySelector('button[aria-label="项目"]'), null);
    assert.ok(rail.querySelector('a[aria-label="打开设置"]'));

    const drawer = dom.document.querySelector('aside.sidebar.sidebar-drawer');
    assert.ok(drawer);
    assert.equal(drawer.querySelector('#sidebar-panel-work'), null);
    assert.match(drawer.textContent ?? '', /新对话/);
    assert.match(drawer.textContent ?? '', /测试对话/);
    assert.doesNotMatch(drawer.textContent ?? '', /资料库/);
    assert.doesNotMatch(drawer.textContent ?? '', /定时任务/);

    // Clicking the active 对话 rail icon collapses the secondary drawer, and clicking again reopens it.
    const chatRailBtn = rail.querySelector('button[aria-label="对话"]');
    await act(async () => { chatRailBtn.click(); });
    assert.equal(dom.document.querySelector('aside.sidebar.sidebar-drawer'), null);
    assert.ok(dom.document.querySelector('nav.sidebar-rail'));

    await act(async () => { chatRailBtn.click(); });
    assert.ok(dom.document.querySelector('aside.sidebar.sidebar-drawer'));
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});

test('desktop target renders 项目 in Activity Rail, switches drawer between Chat and Project, and preserves tab across remount', async () => {
  const dom = setupDom({ mobile: false, target: 'desktop' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree());
    });

    const rail = dom.document.querySelector('nav.sidebar-rail');
    assert.ok(rail);
    const chatBtn = rail.querySelector('button[aria-label="对话"]');
    const projectBtn = rail.querySelector('button[aria-label="项目"]');
    assert.ok(chatBtn);
    assert.ok(projectBtn);
    assert.equal(chatBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(projectBtn.getAttribute('aria-pressed'), 'false');

    // Clicking 项目 switches drawer to project explorer (projects + file tree).
    await act(async () => { projectBtn.click(); });
    assert.equal(projectBtn.getAttribute('aria-pressed'), 'true');
    const drawer = dom.document.querySelector('aside.sidebar.sidebar-drawer');
    assert.ok(drawer);
    const workPanel = drawer.querySelector('#sidebar-panel-work');
    assert.ok(workPanel);
    assert.ok(workPanel.querySelector('button[aria-label="工作区"]'));
    assert.ok(workPanel.querySelector('button[aria-label="创建项目"]'));
    assert.match(workPanel.textContent ?? '', /项目/);
    assert.ok(drawer.querySelector('.work-sidebar-files-section'));
    assert.ok(drawer.querySelector('.sidebar-primary button[aria-label="项目内全局查找"]'));
    assert.equal(drawer.querySelector('.sidebar-header-actions button[aria-label="查找本机文件"]'), null);
    assert.equal(drawer.querySelector('.sidebar-header-actions button[aria-label="搜索对话"]'), null);
    assert.doesNotMatch(drawer.textContent ?? '', /新对话/);

    // Remounting preserves the active Project tab.
    await act(async () => { root.unmount(); });
    const remounted = createRoot(dom.document.getElementById('root'));
    await act(async () => {
      remounted.render(renderSidebarTree());
    });
    assert.ok(dom.document.querySelector('#sidebar-panel-work'));
    assert.equal(dom.document.querySelector('nav.sidebar-rail button[aria-label="项目"]')?.getAttribute('aria-pressed'), 'true');
    await act(async () => { remounted.unmount(); });
  } finally {
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('desktop target on mobile viewport keeps original mobile drawer layout without Activity Rail', async () => {
  const dom = setupDom({ mobile: true, target: 'desktop' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree());
    });

    assert.equal(dom.document.querySelector('nav.sidebar-rail'), null);
    const sidebar = dom.document.querySelector('aside.sidebar');
    assert.ok(sidebar);
    assert.ok(sidebar.querySelector('.sidebar-primary'));
    assert.match(sidebar.textContent ?? '', /新对话/);
    assert.match(sidebar.textContent ?? '', /资料库/);
    assert.match(sidebar.textContent ?? '', /定时任务/);
    assert.match(sidebar.textContent ?? '', /测试对话/);
  } finally {
    await act(async () => { root.unmount(); });
    dom.restore();
  }
});

test('desktop workspace switches to Project with right AI CLI panel and toggles secondary drawer via collapse or rail icon', async () => {
  const dom = setupDom({ mobile: false, target: 'desktop' });
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(renderSidebarTree(true));
    });

    assert.ok(dom.document.querySelector('.chat-placeholder'));
    assert.equal(dom.document.querySelector('main.work-main'), null);

    const projectBtn = dom.document.querySelector('nav.sidebar-rail button[aria-label="项目"]');
    assert.ok(projectBtn);
    await act(async () => { projectBtn.click(); });

    assert.equal(dom.document.querySelector('.chat-placeholder'), null);
    assert.ok(dom.document.querySelector('main.work-main'));
    assert.ok(dom.document.querySelector('.work-topbar .work-tabs'));
    assert.ok(dom.document.querySelector('.work-topbar button[aria-label="添加终端"]'));

    // Right panel is now AI CLI sessions panel (WorkCliPanel).
    const cliToggleBtn = dom.document.querySelector('.work-topbar button[aria-label="收起 AI 对话"]');
    assert.ok(cliToggleBtn);
    assert.ok(dom.document.querySelector('.work-cli-panel'));
    await act(async () => { cliToggleBtn.click(); });
    assert.equal(dom.document.querySelector('.work-cli-panel'), null);
    assert.ok(dom.document.querySelector('.work-topbar button[aria-label="展开 AI 对话"]'));

    // Collapse secondary drawer via drawer header button, then reopen via rail logo button (restores last collapsed Project drawer).
    const collapseBtn = dom.document.querySelector('aside.sidebar-drawer button[aria-label="收起侧栏"]');
    assert.ok(collapseBtn);
    await act(async () => { collapseBtn.click(); });
    assert.equal(dom.document.querySelector('aside.sidebar.sidebar-drawer'), null);
    assert.ok(dom.document.querySelector('nav.sidebar-rail'));

    const logoBtn = dom.document.querySelector('nav.sidebar-rail button.sidebar-rail-brand');
    assert.ok(logoBtn);
    assert.equal(logoBtn.getAttribute('aria-label'), '展开侧栏');
    await act(async () => { logoBtn.click(); });
    assert.ok(dom.document.querySelector('aside.sidebar.sidebar-drawer #sidebar-panel-work'));

    // Switch back to Chat via rail icon.
    const chatBtn = dom.document.querySelector('nav.sidebar-rail button[aria-label="对话"]');
    assert.ok(chatBtn);
    await act(async () => { chatBtn.click(); });
    assert.ok(dom.document.querySelector('.chat-placeholder'));
    assert.equal(dom.document.querySelector('main.work-main'), null);

    // Collapsing from Chat and clicking logo restores Chat drawer.
    await act(async () => { chatBtn.click(); });
    assert.equal(dom.document.querySelector('aside.sidebar.sidebar-drawer'), null);
    await act(async () => { logoBtn.click(); });
    assert.ok(dom.document.querySelector('aside.sidebar.sidebar-drawer #sidebar-panel-chat'));
  } finally {
    await act(async () => { root.unmount(); });
    resetSidebarTabForTests();
    dom.restore();
  }
});
