import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';

import { Workspace } from '../ui/components/web/workspace.tsx';
import { ChatProvider } from '../ui/features/chat/chat-state.tsx';
import { ChatRuntimeProvider } from '../ui/features/chat/chat-runtime.tsx';
import { resetSidebarTabForTests, writeSidebarTab } from '../ui/features/chat/sidebar-mode.ts';
import { InstanceProvider } from '../ui/features/instance/instance-state.tsx';
import { MemoryProvider } from '../ui/features/memory/memory-state.tsx';
import { NetworkToolsProvider } from '../ui/features/instance/network-tools-state.tsx';
import { ModelProvider } from '../ui/features/models/model-state.tsx';
import { PersonalizationProvider } from '../ui/features/settings/personalization-state.tsx';
import { WorkGeneralScreen } from '../ui/features/work/work-general-screen.tsx';
import {
  resetWorkStateForTests,
  setDefaultWindowsShell,
  setWorkPlatformForTests,
  upsertWorkProject,
} from '../ui/features/work/work-state.ts';
import { PreviewContext } from '../ui/features/workspace/preview-context.ts';
import { AppearanceProvider } from '../ui/theme/appearance.tsx';

function setupDom() {
  resetWorkStateForTests();
  resetSidebarTabForTests();
  writeSidebarTab('work');
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
  globalThis.__DEV__ = true;
  globalThis.__MATRIUS_TARGET__ = 'desktop';

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

function renderDesktopWorkspace() {
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
                      conversations: [{ id: 'c1', title: '测试对话', pinned: false, updatedAt: 1, messages: [] }],
                      activeId: null,
                      sidebarOpen: true,
                    },
                  },
                  createElement(
                    ChatRuntimeProvider,
                    null,
                    createElement(Workspace, null, createElement('div', { className: 'chat-placeholder' })),
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

test('work workspace removes project expand, creates terminals via split button/menu, and resizes right files panel', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));

  try {
    upsertWorkProject({
      id: 'proj-1',
      name: 'matrius',
      hostId: 'mock-host-ssh',
      directory: '/home/dev/projects/matrius',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });

    await act(async () => {
      root.render(renderDesktopWorkspace());
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    // Sidebar project row has no expand chevron, no nested terminal list, and no per-project `+`.
    const projectItem = dom.document.querySelector('.work-project-item.is-active');
    assert.ok(projectItem);
    assert.ok(projectItem.querySelector('.work-project-more'));
    assert.equal(projectItem.querySelector('.work-project-add'), null);
    assert.equal(projectItem.querySelector('.work-project-chevron'), null);
    assert.equal(dom.document.querySelector('#work-project-children-proj-1'), null);

    // Right directory panel displays active project's files and expands subdirectories.
    const filesPanel = dom.document.querySelector('.work-files-panel');
    assert.ok(filesPanel);
    assert.match(filesPanel.textContent ?? '', /package\.json/);
    const uiFolderBtn = Array.from(filesPanel.querySelectorAll('.work-tree-row.is-dir'))
      .find((btn) => btn.textContent?.includes('ui'));
    assert.ok(uiFolderBtn);
    await act(async () => { uiFolderBtn.click(); });
    assert.match(filesPanel.textContent ?? '', /main\.tsx/);

    // Dragging the left boundary of the right files panel adjusts width and updates CSS variable.
    const resizer = filesPanel.querySelector('.work-files-resizer[role="separator"]');
    assert.ok(resizer);
    const resizerReactKey = Object.keys(resizer).find((key) => key.startsWith('__reactProps'));
    assert.ok(resizerReactKey);
    await act(async () => {
      resizer[resizerReactKey].onPointerDown({ button: 0, clientX: 800, preventDefault() {} });
    });
    assert.ok(dom.document.querySelector('.work-screen.is-resizing'));
    await act(async () => {
      const moveEvent = new dom.window.Event('pointermove');
      moveEvent.clientX = 720;
      dom.window.dispatchEvent(moveEvent);
      dom.window.dispatchEvent(new dom.window.Event('pointerup'));
    });
    assert.equal(dom.document.querySelector('.work-screen.is-resizing'), null);
    assert.equal(dom.document.querySelector('.work-screen').style.getPropertyValue('--work-files-width'), '400px');

    await act(async () => {
      resizer[resizerReactKey].onKeyDown({ key: 'ArrowLeft', shiftKey: false, preventDefault() {} });
    });
    assert.equal(dom.document.querySelector('.work-screen').style.getPropertyValue('--work-files-width'), '416px');

    // Collapse & re-expand right files panel from topbar.
    const toggleFilesBtn = dom.document.querySelector('.work-topbar button[aria-label="收起工作目录"]');
    assert.ok(toggleFilesBtn);
    await act(async () => { toggleFilesBtn.click(); });
    assert.equal(dom.document.querySelector('.work-files-panel'), null);
    const expandFilesBtn = dom.document.querySelector('.work-topbar button[aria-label="展开工作目录"]');
    assert.ok(expandFilesBtn);
    await act(async () => { expandFilesBtn.click(); });
    assert.ok(dom.document.querySelector('.work-files-panel'));

    // Primary left/center `+` button directly launches a terminal tab without opening a dialog.
    const addBtn = dom.document.querySelector('.work-topbar button[aria-label="添加终端"]');
    assert.ok(addBtn);
    await act(async () => { addBtn.click(); });
    assert.equal(dom.document.querySelector('.work-terminal-dialog'), null);

    const tabs = dom.document.querySelectorAll('.work-topbar .work-tab');
    assert.equal(tabs.length, 1);
    assert.match(tabs[0].textContent ?? '', /终端/);
    assert.ok(dom.document.querySelector('.work-terminal-pane[data-terminal-id]'));
    assert.equal(dom.document.querySelector('#work-project-children-proj-1'), null);

    // Clicking the right caret opens preset dropdown with 终端, brand-logo Claude Code, Codex, and Antigravity (all disabled).
    const caretBtn = dom.document.querySelector('.work-topbar button[aria-label="选择终端类型"]');
    assert.ok(caretBtn);
    await act(async () => { caretBtn.click(); });

    const menu = dom.document.querySelector('.work-add-menu[role="menu"]');
    assert.ok(menu);
    const shellOption = menu.querySelector('button[data-preset="shell"]');
    const claudeOption = menu.querySelector('button[data-preset="claude"]');
    const codexOption = menu.querySelector('button[data-preset="codex"]');
    const antigravityOption = menu.querySelector('button[data-preset="antigravity"]');
    assert.ok(shellOption && claudeOption && codexOption && antigravityOption);
    assert.equal(claudeOption.getAttribute('aria-disabled'), 'true');
    assert.equal(codexOption.getAttribute('aria-disabled'), 'true');
    assert.equal(antigravityOption.getAttribute('aria-disabled'), 'true');
    assert.ok(claudeOption.querySelector('svg path'));
    assert.ok(codexOption.querySelector('svg path'));
    assert.ok(antigravityOption.querySelector('clipPath'));

    // Unimplemented presets do not open terminals when clicked.
    await act(async () => { claudeOption.click(); });
    await act(async () => { codexOption.click(); });
    await act(async () => { antigravityOption.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);

    // Selecting 终端 from the menu creates a second terminal tab.
    await act(async () => { shellOption.click(); });
    assert.equal(dom.document.querySelector('.work-add-menu'), null);

    const twoTabs = dom.document.querySelectorAll('.work-topbar .work-tab');
    assert.equal(twoTabs.length, 2);
    assert.equal(twoTabs[1].classList.contains('is-active'), true);

    await act(async () => { twoTabs[0].querySelector('.work-tab-select').click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab')[0].classList.contains('is-active'), true);

    // Add a third terminal tab to test right-click context menu: pin, rename, close others, close all.
    await act(async () => { addBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 3);

    // Right-click third tab (`终端 3`) -> Pin moves it to the front as a pinned tab without close button,
    // and context menu anchors stably to the clicked tab element instead of cursor coordinates.
    const thirdTab = dom.document.querySelectorAll('.work-topbar .work-tab')[2];
    thirdTab.getBoundingClientRect = () => ({ left: 192, top: 8, bottom: 38, right: 312, width: 120, height: 30 });
    const thirdTabReactKey = Object.keys(thirdTab).find((key) => key.startsWith('__reactProps'));
    assert.ok(thirdTabReactKey);
    await act(async () => {
      thirdTab[thirdTabReactKey].onContextMenu({
        clientX: 299,
        clientY: 29,
        currentTarget: thirdTab,
        preventDefault() {},
      });
    });
    const pinMenu = dom.document.getElementById('work-tab-menu');
    assert.ok(pinMenu);
    assert.equal(pinMenu.style.left, '192px');
    assert.equal(pinMenu.style.top, '44px');
    const pinBtn = pinMenu.querySelector('button[data-action="pin"]');
    assert.ok(pinBtn);
    await act(async () => { pinBtn.click(); });
    assert.equal(dom.document.getElementById('work-tab-menu'), null);

    const afterPinTabs = dom.document.querySelectorAll('.work-topbar .work-tab');
    assert.equal(afterPinTabs[0].classList.contains('is-pinned'), true);
    assert.match(afterPinTabs[0].textContent ?? '', /终端 3/);
    assert.equal(afterPinTabs[0].querySelector('.work-tab-close'), null);
    assert.ok(afterPinTabs[0].querySelector('.work-tab-pin-btn'));

    // Right-click pinned tab -> Rename opens modal and updates the tab title.
    const pinnedReactKey = Object.keys(afterPinTabs[0]).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      afterPinTabs[0][pinnedReactKey].onContextMenu({ clientX: 60, clientY: 24, preventDefault() {} });
    });
    await act(async () => {
      dom.document.querySelector('#work-tab-menu button[data-action="rename"]').click();
    });
    const renameDialog = dom.document.querySelector('.work-tab-rename-dialog[open]');
    assert.ok(renameDialog);
    const renameInput = renameDialog.querySelector('#work-terminal-title-input');
    const renameForm = renameDialog.querySelector('form');
    const renameInputKey = Object.keys(renameInput).find((key) => key.startsWith('__reactProps'));
    const renameFormKey = Object.keys(renameForm).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      renameInput.value = '主构建终端';
      renameInput[renameInputKey].onChange({ target: renameInput });
    });
    await act(async () => {
      await renameForm[renameFormKey].onSubmit({ preventDefault() {} });
    });
    assert.equal(dom.document.querySelector('.work-tab-rename-dialog[open]'), null);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[0].textContent ?? '', /主构建终端/);

    // Right-click second tab -> Close others keeps clicked tab AND pinned tab, closing remaining unpinned tabs.
    const middleTab = dom.document.querySelectorAll('.work-topbar .work-tab')[1];
    const middleReactKey = Object.keys(middleTab).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      middleTab[middleReactKey].onContextMenu({ clientX: 160, clientY: 24, preventDefault() {} });
    });
    await act(async () => {
      dom.document.querySelector('#work-tab-menu button[data-action="close-others"]').click();
    });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[0].textContent ?? '', /主构建终端/);

    // Close all via right-click closes all unpinned tabs while preserving pinned ones.
    const lastTab = dom.document.querySelectorAll('.work-topbar .work-tab')[1];
    const lastReactKey = Object.keys(lastTab).find((key) => key.startsWith('__reactProps'));
    await act(async () => {
      lastTab[lastReactKey].onContextMenu({ clientX: 160, clientY: 24, preventDefault() {} });
    });
    await act(async () => {
      dom.document.querySelector('#work-tab-menu button[data-action="close-all"]').click();
    });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[0].textContent ?? '', /主构建终端/);

    // Clicking the pin icon in the close slot unpins the tab and restores the close button.
    const unpinBtn = dom.document.querySelector('.work-topbar .work-tab .work-tab-pin-btn');
    assert.ok(unpinBtn);
    await act(async () => { unpinBtn.click(); });
    const unpinnedTab = dom.document.querySelector('.work-topbar .work-tab');
    assert.equal(unpinnedTab.classList.contains('is-pinned'), false);
    assert.equal(unpinnedTab.querySelector('.work-tab-pin-btn'), null);
    assert.ok(unpinnedTab.querySelector('.work-tab-close'));
    await act(async () => { unpinnedTab.querySelector('.work-tab-close').click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 0);
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('terminal tabs follow each project, Windows local offers PowerShell/CMD with configurable default, and settings screen updates default shell', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));

  try {
    setWorkPlatformForTests('win32');
    upsertWorkProject({
      id: 'proj-local',
      name: 'matrius',
      hostId: 'local',
      directory: 'D:\\Engineer\\matrius',
      revision: 1,
      createdAt: 2,
      updatedAt: 2,
    });
    upsertWorkProject({
      id: 'proj-remote',
      name: 'remote-api',
      hostId: 'mock-host-ssh',
      directory: '/srv/api',
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });

    await act(async () => {
      root.render(renderDesktopWorkspace());
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    // Switch back to local Windows project (`proj-local`) and open dropdown: PowerShell and CMD appear.
    const localBtn = Array.from(dom.document.querySelectorAll('.work-project-select'))
      .find((btn) => btn.textContent?.includes('matrius'));
    assert.ok(localBtn);
    await act(async () => { localBtn.click(); });

    const caretBtn = dom.document.querySelector('.work-topbar button[aria-label="选择终端类型"]');
    await act(async () => { caretBtn.click(); });
    const menu = dom.document.querySelector('.work-add-menu[role="menu"]');
    assert.ok(menu.querySelector('button[data-shell="powershell"]'));
    assert.ok(menu.querySelector('button[data-shell="cmd"]'));

    // Primary `+` opens PowerShell by default on Windows local, then CMD overrides when set in Settings.
    const addBtn = dom.document.querySelector('.work-topbar button[aria-label="添加终端"]');
    await act(async () => { addBtn.click(); });
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[0].textContent ?? '', /PowerShell/);

    await act(async () => { setDefaultWindowsShell('cmd'); });
    await act(async () => { addBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[1].textContent ?? '', /CMD/);

    // Switch sidebar project to `proj-remote` -> local tabs disappear and remote starts with its own empty tab bar.
    const remoteBtn = Array.from(dom.document.querySelectorAll('.work-project-select'))
      .find((btn) => btn.textContent?.includes('remote-api'));
    assert.ok(remoteBtn);
    await act(async () => { remoteBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 0);

    // Remote non-Windows project creates generic 终端; closing all in remote must keep local project's tabs intact.
    await act(async () => { addBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[0].textContent ?? '', /终端/);

    await act(async () => { localBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab')[1].classList.contains('is-active'), true);
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('WorkGeneralScreen enables Windows default terminal selector only on Windows', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));

  function wrap(children) {
    return createElement(
      AppearanceProvider,
      null,
      createElement(
        InstanceProvider,
        { preview: true },
        createElement(
          PreviewContext.Provider,
          { value: true },
          createElement(ChatProvider, { initialState: { conversations: [], activeId: null, sidebarOpen: true } }, children),
        ),
      ),
    );
  }

  try {
    setWorkPlatformForTests('linux');
    await act(async () => { root.render(wrap(createElement(WorkGeneralScreen))); });
    let trigger = dom.document.querySelector('#work-default-terminal button.select-field-trigger');
    assert.ok(trigger);
    assert.equal(trigger.disabled, true);

    await act(async () => { setWorkPlatformForTests('win32'); });
    await act(async () => { root.render(wrap(createElement(WorkGeneralScreen))); });
    trigger = dom.document.querySelector('#work-default-terminal button.select-field-trigger');
    assert.ok(trigger);
    assert.equal(trigger.disabled, false);
  } finally {
    await act(async () => { root.unmount(); });
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});
