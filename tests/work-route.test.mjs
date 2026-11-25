import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { router } from '@/router';
import { ChatProvider } from '../ui/features/chat/chat-state.tsx';
import { ChatRuntimeProvider } from '../ui/features/chat/chat-runtime.tsx';
import { Sidebar } from '../ui/features/chat/components/sidebar.tsx';
import { resetSidebarTabForTests, writeSidebarTab } from '../ui/features/chat/sidebar-mode.ts';
import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { MemoryProvider } from '../ui/features/memory/memory-state.tsx';
import { ModelProvider } from '../ui/features/models/model-state.tsx';
import { NetworkToolsProvider } from '../ui/features/instance/network-tools-state.tsx';
import { PersonalizationProvider } from '../ui/features/settings/personalization-state.tsx';
import { WorkSidebarPanel } from '../ui/features/work/work-sidebar-panel.tsx';
import WorkRoute from '../ui/features/work/work-route.tsx';
import {
  isWorkPath,
  sidebarTabForPathname,
  workHref,
  workProjectIdIn,
} from '../ui/features/work/work-href.ts';
import {
  getWorkState,
  hydrateWorkSettings,
  resetWorkStateForTests,
  setWorkProjects,
} from '../ui/features/work/work-state.ts';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';
import { AppearanceProvider } from '../ui/theme/appearance.tsx';

function setupDom(initialPathname = '/work') {
  resetWorkStateForTests();
  resetSidebarTabForTests();
  const { window, document } = parseHTML('<!doctype html><html><head><title>Matrius</title></head><body><div id="root"></div></body></html>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    location: globalThis.location,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    dev: globalThis.__DEV__,
    target: globalThis.__MATRIUS_TARGET__,
    push: router.push,
    replace: router.replace,
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

  let currentPathname = initialPathname;
  const navCalls = [];
  const locationProxy = {
    get pathname() { return currentPathname; },
    set pathname(value) { currentPathname = value; },
  };
  router.push = (href) => {
    navCalls.push({ method: 'push', href });
    currentPathname = href;
    window.dispatchEvent(new window.Event('popstate'));
  };
  router.replace = (href) => {
    navCalls.push({ method: 'replace', href });
    currentPathname = href;
    window.dispatchEvent(new window.Event('popstate'));
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.location = locationProxy;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__DEV__ = true;
  globalThis.__MATRIUS_TARGET__ = 'desktop';

  return {
    document,
    navCalls,
    setPathname(nextPath) {
      currentPathname = nextPath;
      window.dispatchEvent(new window.Event('popstate'));
    },
    restore() {
      router.push = previous.push;
      router.replace = previous.replace;
      globalThis.window = previous.window;
      globalThis.document = previous.document;
      globalThis.HTMLElement = previous.HTMLElement;
      globalThis.Node = previous.Node;
      globalThis.Event = previous.Event;
      globalThis.location = previous.location;
      globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
      globalThis.__DEV__ = previous.dev;
      globalThis.__MATRIUS_TARGET__ = previous.target;
    },
  };
}

test('workHref, workProjectIdIn, isWorkPath, and sidebarTabForPathname distinguish projects from conversations', () => {
  assert.equal(workHref(null, false), '/work');
  assert.equal(workHref('proj-1', false), '/p/proj-1');
  assert.equal(workHref('a b', false), '/p/a%20b');
  assert.equal(workHref(null, true), '/mock/chat/work');
  assert.equal(workHref('proj-1', true), '/mock/chat/p/proj-1');

  assert.equal(workProjectIdIn('/p/proj-1', false), 'proj-1');
  assert.equal(workProjectIdIn('/p/a%20b/', false), 'a b');
  assert.equal(workProjectIdIn('/work', false), null);
  assert.equal(workProjectIdIn('/c/conv-1', false), null);
  assert.equal(workProjectIdIn('/mock/chat/p/proj-1', true), 'proj-1');
  assert.equal(workProjectIdIn('/p/proj-1', true), null);

  assert.equal(isWorkPath('/work'), true);
  assert.equal(isWorkPath('/p'), true);
  assert.equal(isWorkPath('/p/proj-1'), true);
  assert.equal(isWorkPath('/mock/chat/work'), true);
  assert.equal(isWorkPath('/mock/chat/p/proj-1'), true);
  assert.equal(isWorkPath('/'), false);
  assert.equal(isWorkPath('/c/conv-1'), false);
  assert.equal(isWorkPath('/library'), false);

  assert.equal(sidebarTabForPathname('/work'), 'work');
  assert.equal(sidebarTabForPathname('/p/proj-1'), 'work');
  assert.equal(sidebarTabForPathname('/mock/chat/p/proj-1'), 'work');
  assert.equal(sidebarTabForPathname('/'), 'chat');
  assert.equal(sidebarTabForPathname('/c/conv-1'), 'chat');
  assert.equal(sidebarTabForPathname('/library'), 'chat');
  assert.equal(sidebarTabForPathname('/tasks'), 'chat');
  assert.equal(sidebarTabForPathname('/mock/chat'), 'chat');
  assert.equal(sidebarTabForPathname('/settings/hosts'), null);
  assert.equal(sidebarTabForPathname('/mock/chat/settings/hosts'), null);
});

test('WorkRoute selects project from URL, redirects /work to active project, and reports missing project', async () => {
  const dom = setupDom('/p/p2');
  const root = createRoot(dom.document.getElementById('root'));

  const p1 = { id: 'p1', name: 'Alpha', hostId: 'local', directory: 'D:\\alpha', revision: 1, createdAt: 1, updatedAt: 1 };
  const p2 = { id: 'p2', name: 'Beta', hostId: 'local', directory: 'D:\\beta', revision: 1, createdAt: 2, updatedAt: 2 };

  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: false },
          createElement(
            PreviewContext.Provider,
            { value: false },
            createElement(WorkRoute),
          ),
        ),
      );
    });

    // While projects are still loading, WorkRoute waits without showing a missing dialog.
    assert.equal(dom.document.querySelector('.compact-dialog[open]'), null);
    assert.equal(dom.document.querySelector('.work-screen'), null);

    // Simulate settings preferring p1 while URL explicitly asks for p2; p2 wins.
    await act(async () => {
      hydrateWorkSettings({
        defaultWindowsShell: 'powershell',
        activeProjectId: 'p1',
        activeTerminals: {},
      });
      setWorkProjects([p1, p2]);
    });

    assert.equal(getWorkState().activeProjectId, 'p2');
    assert.ok(dom.document.querySelector('.work-screen'));
    assert.equal(dom.document.title, 'Beta');

    // Navigating to an unknown project id opens the missing-project dialog and preserves fallback active project.
    await act(async () => {
      dom.setPathname('/p/missing-id');
    });
    const missingDialog = dom.document.querySelector('.compact-dialog[open]');
    assert.ok(missingDialog);
    assert.match(missingDialog.textContent ?? '', /项目不存在/);
    const returnBtn = missingDialog.querySelector('button');
    assert.ok(returnBtn);
    await act(async () => { returnBtn.click(); });
    assert.deepEqual(dom.navCalls.at(-1), { method: 'replace', href: '/p/p2' });
    assert.ok(dom.document.querySelector('.work-screen'));

    // Navigating away from `/p/p2` to `/settings` or `/c/conv-1` must NOT bounce back to `/p/p2`
    // before WorkRoute unmounts.
    const callsBeforeLeave = dom.navCalls.length;
    await act(async () => {
      dom.setPathname('/settings');
    });
    assert.equal(dom.navCalls.length, callsBeforeLeave);
    await act(async () => {
      dom.setPathname('/c/conv-1');
    });
    assert.equal(dom.navCalls.length, callsBeforeLeave);

    // Bare /work redirects to the active project URL once loaded.
    await act(async () => {
      dom.setPathname('/work');
    });
    assert.deepEqual(dom.navCalls.at(-1), { method: 'replace', href: '/p/p2' });
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    dom.restore();
  }
});

test('Sidebar mode switch and WorkSidebarPanel update URLs for projects vs conversations', async () => {
  const dom = setupDom('/');
  const root = createRoot(dom.document.getElementById('root'));

  const p1 = { id: 'p1', name: 'Alpha', hostId: 'local', directory: 'D:\\alpha', revision: 1, createdAt: 1, updatedAt: 1 };
  const p2 = { id: 'p2', name: 'Beta', hostId: 'local', directory: 'D:\\beta', revision: 1, createdAt: 2, updatedAt: 2 };

  try {
    setWorkProjects([p1, p2]);

    await act(async () => {
      root.render(
        createElement(
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
                              { id: 'conv-1', title: '测试会话', pinned: false, updatedAt: 1, messages: [] },
                            ],
                            activeId: 'conv-1',
                            sidebarOpen: true,
                          },
                        },
                        createElement(
                          ChatRuntimeProvider,
                          null,
                          createElement(Sidebar, { onSearch: () => {}, collapsed: false }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    });

    // Switching from 对话 -> 项目 pushes the active project's preview URL.
    const workTab = dom.document.querySelector('nav.sidebar-rail button[aria-label="项目"]');
    assert.ok(workTab);
    await act(async () => { workTab.click(); });
    assert.deepEqual(dom.navCalls.at(-1), { method: 'push', href: '/mock/chat/p/p1' });

    // Wait for lazy WorkSidebarPanel to mount, then click project p2 -> pushes /mock/chat/p/p2.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    const p2Btn = dom.document.querySelector('.work-project-item[data-project-id="p2"] .work-project-select');
    assert.ok(p2Btn);
    await act(async () => { p2Btn.click(); });
    assert.equal(getWorkState().activeProjectId, 'p2');
    assert.deepEqual(dom.navCalls.at(-1), { method: 'push', href: '/mock/chat/p/p2' });

    // Switching back to 对话 pushes the active conversation's preview URL.
    const chatTab = dom.document.querySelector('nav.sidebar-rail button[aria-label="对话"]');
    assert.ok(chatTab);
    await act(async () => { chatTab.click(); });
    assert.deepEqual(dom.navCalls.at(-1), { method: 'push', href: '/mock/chat/c/conv-1' });
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('WorkSidebarPanel updates URL when creating or removing projects', async () => {
  const dom = setupDom('/mock/chat/work');
  const root = createRoot(dom.document.getElementById('root'));

  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: true },
          createElement(
            PreviewContext.Provider,
            { value: true },
            createElement(
              ChatProvider,
              null,
              createElement(WorkSidebarPanel),
            ),
          ),
        ),
      );
    });

    // Create a project from `/mock/chat/work` -> replaces URL with `/mock/chat/p/<id>`.
    const openCreateBtn = dom.document.querySelector('button[aria-label="创建项目"]');
    assert.ok(openCreateBtn);
    await act(async () => { openCreateBtn.click(); });

    const createDialog = dom.document.querySelector('.work-project-dialog[open]');
    assert.ok(createDialog);
    await act(async () => { createDialog.querySelector('.work-dir-picker').click(); });
    const browserDialog = dom.document.querySelector('.work-browser-dialog[open]');
    assert.ok(browserDialog);
    const chooseBtn = Array.from(browserDialog.querySelectorAll('.dialog-footer button'))
      .find((btn) => btn.textContent?.includes('选择当前目录'));
    assert.ok(chooseBtn);
    await act(async () => { chooseBtn.click(); });

    const createForm = createDialog.querySelector('form');
    const createFormKey = Object.keys(createForm).find((key) => key.startsWith('__reactProps'));
    await act(async () => { await createForm[createFormKey].onSubmit({ preventDefault() {} }); });

    const createdId = getWorkState().activeProjectId;
    assert.ok(createdId);
    assert.deepEqual(dom.navCalls.at(-1), {
      method: 'replace',
      href: `/mock/chat/p/${encodeURIComponent(createdId)}`,
    });

    // Remove the only project -> replaces URL back to `/mock/chat/work`.
    const projectItem = dom.document.querySelector(`.work-project-item[data-project-id="${createdId}"]`);
    assert.ok(projectItem);
    const projectItemKey = Object.keys(projectItem).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      projectItem[projectItemKey].onContextMenu({
        clientX: 40,
        clientY: 120,
        currentTarget: projectItem,
        preventDefault() {},
      });
    });
    const removeMenuItem = Array.from(dom.document.querySelectorAll('#work-project-menu [role="menuitem"]'))
      .find((item) => item.textContent?.includes('移除项目'));
    assert.ok(removeMenuItem);
    await act(async () => { removeMenuItem.click(); });
    const confirmRemoveBtn = dom.document.querySelector('.compact-dialog[open] .danger-button');
    assert.ok(confirmRemoveBtn);
    await act(async () => { confirmRemoveBtn.click(); });

    assert.equal(getWorkState().activeProjectId, null);
    assert.deepEqual(dom.navCalls.at(-1), { method: 'replace', href: '/mock/chat/work' });
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});
