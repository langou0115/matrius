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
import { WorkSidebarPanel } from '../ui/features/work/work-sidebar-panel.tsx';
import { attachTerminalClipboard } from '../ui/features/work/work-terminal-view.tsx';
import {
  normalizeConptyClearChunk,
  trimScrollbackAtEraseSavedLines,
} from '../contract/work-terminals.ts';
import {
  getWorkState,
  hydrateWorkSettings,
  reorderWorkCliProviders,
  reorderWorkProjects,
  resetWorkStateForTests,
  setDefaultWindowsShell,
  setWorkPlatformForTests,
  setWorkProjectCliSessions,
  setWorkProjects,
  setWorkServerPlatform,
  setWorkTerminals,
  updateWorkTerminalStatus,
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

test('work workspace separates project selection from explicit expand, shows CLI sessions with status and show-more, and enables Claude/Codex/Antigravity', async () => {
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

    // Sidebar project row has explicit visible expand toggle, no `...` button or inline add button, and starts collapsed.
    const projectItem = dom.document.querySelector('.work-project-item.is-active');
    assert.ok(projectItem);
    assert.equal(projectItem.querySelector('.work-project-more'), null);
    assert.equal(projectItem.querySelector('.work-project-add'), null);
    assert.ok(dom.document.querySelector('.work-topbar button[aria-label="添加终端"]'));
    const toggleBtn = projectItem.querySelector('.work-project-toggle');
    assert.ok(toggleBtn);
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false');
    assert.equal(dom.document.querySelector('#work-project-children-proj-1'), null);

    // Clicking the project row itself does NOT expand it; clicking the explicit toggle expands CLI conversations.
    await act(async () => { projectItem.querySelector('.work-project-select').click(); });
    assert.equal(dom.document.querySelector('#work-project-children-proj-1'), null);

    await act(async () => { toggleBtn.click(); });
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true');
    const childrenPanel = dom.document.querySelector('#work-project-children-proj-1');
    assert.ok(childrenPanel);

    // Expanded project groups CLI conversations by provider (Codex, Antigravity, Claude Code),
    // puts brand icons only on group headers (not on individual sessions), and places 显示更多 / 收起 inside groups.
    const groups = Array.from(childrenPanel.querySelectorAll('.work-cli-group'));
    assert.deepEqual(groups.map((el) => el.getAttribute('data-cli-provider')), ['codex', 'antigravity', 'claude']);

    const codexGroup = groups[0];
    const agyGroup = groups[1];
    const claudeGroup = groups[2];
    assert.ok(codexGroup.querySelector('.work-cli-group-header .work-cli-group-icon svg'));
    assert.ok(agyGroup.querySelector('.work-cli-group-header .work-cli-group-icon svg'));
    assert.ok(claudeGroup.querySelector('.work-cli-group-header .work-cli-group-icon svg'));
    assert.equal(codexGroup.querySelector('.work-cli-session-btn .work-cli-session-icon'), null);

    assert.equal(codexGroup.querySelectorAll('.work-cli-session-btn').length, 5);
    assert.equal(agyGroup.querySelectorAll('.work-cli-session-btn').length, 2);
    assert.equal(claudeGroup.querySelectorAll('.work-cli-session-btn').length, 2);
    assert.ok(codexGroup.querySelector('.work-cli-status.is-running .conversation-spinner'));
    assert.ok(codexGroup.querySelector('.work-cli-status.is-completed svg'));

    assert.equal(agyGroup.querySelector('.work-project-show-more'), null);
    assert.equal(claudeGroup.querySelector('.work-project-show-more'), null);
    const showMoreBtn = codexGroup.querySelector('.work-project-show-more');
    assert.ok(showMoreBtn);
    assert.match(showMoreBtn.textContent ?? '', /显示更多/);
    assert.equal(codexGroup.querySelector('.work-project-show-less'), null);

    await act(async () => { showMoreBtn.click(); });
    assert.equal(codexGroup.querySelectorAll('.work-cli-session-btn').length, 7);
    assert.equal(codexGroup.querySelector('.work-project-show-more'), null);

    const showLessBtn = codexGroup.querySelector('.work-project-show-less');
    assert.ok(showLessBtn);
    assert.match(showLessBtn.textContent ?? '', /收起/);

    await act(async () => { showLessBtn.click(); });
    assert.equal(codexGroup.querySelectorAll('.work-cli-session-btn').length, 5);
    assert.equal(codexGroup.querySelector('.work-project-show-less'), null);
    assert.ok(codexGroup.querySelector('.work-project-show-more'));

    // Dragging Claude Code group header onto Codex reorders conversation groups.
    const claudeHeader = claudeGroup.querySelector('.work-cli-group-header');
    const codexHeader = codexGroup.querySelector('.work-cli-group-header');
    assert.ok(claudeHeader && codexHeader);
    const claudeHeaderProps = Object.keys(claudeHeader).find((key) => key.startsWith('__reactProps'));
    const codexHeaderProps = Object.keys(codexHeader).find((key) => key.startsWith('__reactProps'));
    assert.ok(claudeHeaderProps && codexHeaderProps);
    await act(async () => {
      claudeHeader[claudeHeaderProps].onDragStart({ stopPropagation() {}, preventDefault() {} });
    });
    await act(async () => {
      codexHeader[codexHeaderProps].onDragOver({ clientY: 0, currentTarget: codexHeader, stopPropagation() {}, preventDefault() {} });
      codexHeader[codexHeaderProps].onDrop({ clientY: 0, currentTarget: codexHeader, stopPropagation() {}, preventDefault() {} });
    });
    assert.deepEqual(
      Array.from(childrenPanel.querySelectorAll('.work-cli-group')).map((el) => el.getAttribute('data-cli-provider')),
      ['claude', 'codex', 'antigravity'],
    );
    await act(async () => { reorderWorkCliProviders('codex', 'claude', 'before'); });
    assert.deepEqual(
      Array.from(childrenPanel.querySelectorAll('.work-cli-group')).map((el) => el.getAttribute('data-cli-provider')),
      ['codex', 'claude', 'antigravity'],
    );

    // Collapsing an individual CLI group hides only its sessions.
    await act(async () => { claudeHeader.querySelector('.work-cli-group-toggle').click(); });
    assert.equal(childrenPanel.querySelectorAll('.work-cli-group[data-cli-provider="claude"] .work-cli-session-btn').length, 0);
    await act(async () => { claudeHeader.querySelector('.work-cli-group-toggle').click(); });
    assert.equal(childrenPanel.querySelectorAll('.work-cli-group[data-cli-provider="claude"] .work-cli-session-btn').length, 2);

    // Clicking a CLI session resumes/opens a tab once and focuses it on repeated clicks.
    const codexCliBtn = childrenPanel.querySelector('.work-cli-session-btn[data-cli-provider="codex"]');
    assert.ok(codexCliBtn);
    await act(async () => { codexCliBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);
    assert.equal(codexCliBtn.classList.contains('is-active'), true);

    await act(async () => { codexCliBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);

    // Collapse the project back via the explicit toggle without losing active project or open tab.
    await act(async () => { toggleBtn.click(); });
    assert.equal(dom.document.querySelector('#work-project-children-proj-1'), null);
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);

    // Expanding a project with 0 CLI conversations still renders the 3 groups (`+` new conversation actions) without empty placeholder text.
    await act(async () => {
      setWorkProjectCliSessions('proj-1', { projectId: 'proj-1', items: [], total: 0, hasMore: false });
      toggleBtn.click();
    });
    assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true');
    const emptyChildren = dom.document.querySelector('#work-project-children-proj-1');
    assert.ok(emptyChildren);
    assert.equal(emptyChildren.querySelectorAll('.work-cli-group').length, 3);
    assert.equal(emptyChildren.querySelectorAll('.work-cli-session-btn').length, 0);
    assert.equal(emptyChildren.querySelector('.work-cli-group-chevron'), null);
    assert.doesNotMatch(dom.document.querySelector('.work-project-group')?.textContent ?? '', /暂无|读取/);

    // Clicking each group's `+` button creates at most one new conversation per group (repeated clicks focus the existing one).
    const claudeAddBtn = emptyChildren.querySelector('.work-cli-group-add[data-cli-provider="claude"]');
    const codexAddBtn = emptyChildren.querySelector('.work-cli-group-add[data-cli-provider="codex"]');
    const agyAddBtn = emptyChildren.querySelector('.work-cli-group-add[data-cli-provider="antigravity"]');
    assert.ok(claudeAddBtn && codexAddBtn && agyAddBtn);

    await act(async () => { claudeAddBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[1].textContent ?? '', /Claude Code/);

    // Repeating clicks on the same group's `+` must reuse its existing new conversation tab rather than spawning a second one.
    await act(async () => { claudeAddBtn.click(); });
    await act(async () => { claudeAddBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab')[1].classList.contains('is-active'), true);

    await act(async () => { codexAddBtn.click(); });
    await act(async () => { codexAddBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 3);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[2].textContent ?? '', /Codex/);

    await act(async () => { agyAddBtn.click(); });
    await act(async () => { agyAddBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 4);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[3].textContent ?? '', /Antigravity/);

    for (let i = 0; i < 3; i += 1) {
      await act(async () => { dom.document.querySelectorAll('.work-topbar .work-tab')[1].querySelector('.work-tab-close').click(); });
    }
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);

    // Clicking Claude `+` again after closing that tab starts a fresh new conversation tab.
    await act(async () => { claudeAddBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    await act(async () => { dom.document.querySelectorAll('.work-topbar .work-tab')[1].querySelector('.work-tab-close').click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);

    await act(async () => { toggleBtn.click(); });

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

    // Close the resumed CLI tab so subsequent terminal count assertions start clean.
    await act(async () => { dom.document.querySelector('.work-topbar .work-tab .work-tab-close').click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 0);

    // Topbar `+` button directly launches a terminal tab without opening a dialog.
    const addBtn = dom.document.querySelector('.work-topbar button[aria-label="添加终端"]');
    assert.ok(addBtn);
    await act(async () => { addBtn.click(); });
    assert.equal(dom.document.querySelector('.work-terminal-dialog'), null);

    const tabs = dom.document.querySelectorAll('.work-topbar .work-tab');
    assert.equal(tabs.length, 1);
    assert.match(tabs[0].textContent ?? '', /终端/);
    assert.ok(dom.document.querySelector('.work-terminal-pane[data-terminal-id]'));
    assert.equal(dom.document.querySelector('#work-project-children-proj-1'), null);

    // Topbar caret menu offers 终端 without Claude Code / Codex / Antigravity presets (moved to CLI groups).
    const caretBtn = dom.document.querySelector('.work-topbar button[aria-label="选择终端类型"]');
    assert.ok(caretBtn);
    await act(async () => { caretBtn.click(); });
    const addMenu = dom.document.querySelector('.work-add-menu[role="menu"]');
    assert.ok(addMenu);
    const shellOption = addMenu.querySelector('button[data-preset="shell"]');
    assert.ok(shellOption);
    assert.equal(addMenu.querySelector('button[data-preset="claude"]'), null);
    assert.equal(addMenu.querySelector('button[data-preset="codex"]'), null);
    assert.equal(addMenu.querySelector('button[data-preset="antigravity"]'), null);
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

    // Switch back to local Windows project (`proj-local`) and open dropdown on the topbar: PowerShell and CMD appear (no CLI presets).
    const localRowEl = dom.document.querySelector('.work-project-item[data-project-id="proj-local"]');
    const remoteRowEl = dom.document.querySelector('.work-project-item[data-project-id="proj-remote"]');
    assert.ok(localRowEl && remoteRowEl);
    assert.equal(localRowEl.querySelector('.work-project-add-split'), null);
    assert.equal(remoteRowEl.querySelector('.work-project-add'), null);
    const localBtn = localRowEl.querySelector('.work-project-select');
    assert.ok(localBtn);
    await act(async () => { localBtn.click(); });

    const caretBtn = dom.document.querySelector('.work-topbar button[aria-label="选择终端类型"]');
    assert.ok(caretBtn);
    await act(async () => { caretBtn.click(); });
    const menu = dom.document.querySelector('.work-add-menu[role="menu"]');
    assert.ok(menu);
    assert.ok(menu.querySelector('button[data-shell="powershell"]'));
    assert.ok(menu.querySelector('button[data-shell="cmd"]'));
    assert.equal(menu.querySelector('button[data-preset="claude"]'), null);
    assert.equal(menu.querySelector('button[data-preset="codex"]'), null);
    assert.equal(menu.querySelector('button[data-preset="antigravity"]'), null);
    await act(async () => { caretBtn.click(); });

    // Topbar `+` opens PowerShell by default on Windows local, then CMD overrides when set in Settings.
    const addBtn = dom.document.querySelector('.work-topbar button[aria-label="添加终端"]');
    assert.ok(addBtn);
    await act(async () => { addBtn.click(); });
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[0].textContent ?? '', /PowerShell/);

    await act(async () => { setDefaultWindowsShell('cmd'); });
    await act(async () => { addBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[1].textContent ?? '', /CMD/);

    // Switch sidebar project to `proj-remote` -> local tabs disappear and remote starts with its own empty tab bar.
    const remoteBtn = remoteRowEl.querySelector('.work-project-select');
    assert.ok(remoteBtn);
    await act(async () => { remoteBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 0);

    // Remote non-Windows project creates generic 终端 from the topbar; switching back keeps local tabs intact.
    await act(async () => { addBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 1);
    assert.match(dom.document.querySelectorAll('.work-topbar .work-tab')[0].textContent ?? '', /终端/);

    await act(async () => { localBtn.click(); });
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab').length, 2);
    assert.equal(dom.document.querySelectorAll('.work-topbar .work-tab')[1].classList.contains('is-active'), true);

    // Restored or exited terminal tabs must not render an unread-like solid dot.
    const firstTermId = getWorkState().terminals.find((item) => item.projectId === 'proj-local')?.id;
    assert.ok(firstTermId);
    await act(async () => { updateWorkTerminalStatus(firstTermId, 'restored', null); });
    assert.equal(dom.document.querySelector('.work-topbar .work-tab-status'), null);
    await act(async () => { updateWorkTerminalStatus(firstTermId, 'exited', 0); });
    assert.equal(dom.document.querySelector('.work-topbar .work-tab-status'), null);

    // Dragging project rows reorders the sidebar project list (proj-remote was prepended after proj-local).
    const projectRows = Array.from(dom.document.querySelectorAll('.work-project-item'));
    assert.deepEqual(projectRows.map((el) => el.getAttribute('data-project-id')), ['proj-remote', 'proj-local']);
    const remoteRow = projectRows[0];
    const localRow = projectRows[1];
    const remoteRowProps = Object.keys(remoteRow).find((key) => key.startsWith('__reactProps'));
    const localRowProps = Object.keys(localRow).find((key) => key.startsWith('__reactProps'));
    assert.ok(remoteRowProps && localRowProps);
    await act(async () => {
      localRow[localRowProps].onDragStart({ preventDefault() {} });
    });
    await act(async () => {
      remoteRow[remoteRowProps].onDragOver({ clientY: 0, currentTarget: remoteRow, preventDefault() {} });
      remoteRow[remoteRowProps].onDrop({ clientY: 0, currentTarget: remoteRow, preventDefault() {} });
    });
    assert.deepEqual(
      Array.from(dom.document.querySelectorAll('.work-project-item')).map((el) => el.getAttribute('data-project-id')),
      ['proj-local', 'proj-remote'],
    );
    await act(async () => { reorderWorkProjects('proj-remote', 'proj-local', 'before'); });
    assert.deepEqual(
      Array.from(dom.document.querySelectorAll('.work-project-item')).map((el) => el.getAttribute('data-project-id')),
      ['proj-remote', 'proj-local'],
    );
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
    const scrollbackToggle = dom.document.querySelector('#work-terminal-scrollback input[type="checkbox"]');
    assert.ok(scrollbackToggle);
    assert.equal(scrollbackToggle.checked, false);
    assert.equal(scrollbackToggle.disabled, false);

    const togglePropsKey = Object.keys(scrollbackToggle).find((key) => key.startsWith('__reactProps'));
    assert.ok(togglePropsKey);
    await act(async () => {
      scrollbackToggle.checked = true;
      scrollbackToggle[togglePropsKey].onChange({ target: scrollbackToggle });
    });
    assert.equal(getWorkState().persistTerminalScrollback, true);
    assert.equal(dom.document.querySelector('#work-terminal-scrollback input[type="checkbox"]').checked, true);

    await act(async () => {
      scrollbackToggle.checked = false;
      scrollbackToggle[togglePropsKey].onChange({ target: scrollbackToggle });
    });
    assert.equal(getWorkState().persistTerminalScrollback, false);
    assert.equal(dom.document.querySelector('#work-terminal-scrollback input[type="checkbox"]').checked, false);

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

test('SQLite work settings hydration preserves activeProjectId and per-project active/pinned/renamed tabs on restart', () => {
  const dom = setupDom();
  try {
    setWorkProjects([
      { id: 'proj-a', name: 'A', hostId: 'local', directory: 'D:\\A', revision: 1, createdAt: 1, updatedAt: 1 },
      { id: 'proj-b', name: 'B', hostId: 'local', directory: 'D:\\B', revision: 1, createdAt: 2, updatedAt: 2 },
    ]);
    hydrateWorkSettings({
      defaultWindowsShell: 'cmd',
      activeProjectId: 'proj-b',
      activeTerminals: { 'proj-a': 'term-a2', 'proj-b': 'term-b1' },
      filesPanelOpen: false,
      filesPanelWidth: 420,
      persistTerminalScrollback: true,
      projectOrder: ['proj-b', 'proj-a'],
      cliProviderOrder: ['claude', 'codex', 'antigravity'],
    });
    setWorkTerminals([
      { id: 'term-a1', projectId: 'proj-a', hostId: 'local', title: 'PowerShell', preset: 'shell', shell: 'powershell', command: '', cwd: 'D:\\A', status: 'restored', exitCode: null, pinned: false, createdAt: 1 },
      { id: 'term-a2', projectId: 'proj-a', hostId: 'local', title: '构建标签', preset: 'shell', shell: 'cmd', command: '', cwd: 'D:\\A\\ui', status: 'restored', exitCode: null, pinned: true, createdAt: 2 },
      { id: 'term-b1', projectId: 'proj-b', hostId: 'local', title: '服务日志', preset: 'shell', shell: 'cmd', command: '', cwd: 'D:\\B', status: 'restored', exitCode: null, pinned: true, createdAt: 3 },
    ]);

    const snapshot = getWorkState();
    assert.deepEqual(snapshot.projects.map((item) => item.id), ['proj-b', 'proj-a']);
    assert.deepEqual(snapshot.cliProviderOrder, ['claude', 'codex', 'antigravity']);
    assert.equal(snapshot.activeProjectId, 'proj-b');
    assert.equal(snapshot.activeTerminalId, 'term-b1');
    assert.equal(snapshot.defaultWindowsShell, 'cmd');
    assert.equal(snapshot.filesPanelOpen, false);
    assert.equal(snapshot.filesPanelWidth, 420);
    assert.equal(snapshot.persistTerminalScrollback, true);
    assert.equal(snapshot.terminals[0].title, '构建标签');
    assert.equal(snapshot.terminals[0].pinned, true);
  } finally {
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('normalizeConptyClearChunk strips pre-home ConPTY newlines after ED 3 and trims prior scrollback', () => {
  const conptyClear = '\x1b[?25l\x1b[3J\x1b[m\r\n\x1b[HPS D:\\Engineer\\matrius>\x1b[K\r\n\x1b[K';
  assert.equal(
    normalizeConptyClearChunk(conptyClear),
    '\x1b[?25l\x1b[3J\x1b[m\x1b[HPS D:\\Engineer\\matrius>\x1b[K\r\n\x1b[K',
  );

  // Regular output without ED 3 or newlines after CSI H must stay untouched.
  const regular = 'line-1\r\nline-2\r\n\x1b[Hprompt> ';
  assert.equal(normalizeConptyClearChunk(regular), regular);

  // Saved server scrollback trims everything before the last ED 3 and collapses split ConPTY clear sequences.
  const combined = 'old-1\r\nold-2\r\n\x1b[?25l\x1b[3J\x1b[m\r\n' + '\x1b[1;1HPS D:\\repo>\r\n';
  assert.equal(
    trimScrollbackAtEraseSavedLines(combined),
    '\x1b[3J\x1b[m\x1b[1;1HPS D:\\repo>\r\n',
  );

  const dom = setupDom();
  try {
    setWorkServerPlatform('win32', 22631);
    assert.equal(getWorkState().serverPlatform, 'win32');
    assert.equal(getWorkState().windowsBuild, 22631);
  } finally {
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('attachTerminalClipboard supports right-click copy on selection, Ctrl+C copy/interrupt, and Ctrl+V native paste', async () => {
  const dom = setupDom();
  try {
    const container = dom.document.createElement('div');
    dom.document.body.append(container);
    let selected = 'copied text';
    let cleared = 0;
    let focused = 0;
    let interrupted = 0;
    const copied = [];
    let keyHandler = null;

    const cleanup = attachTerminalClipboard({
      terminal: {
        hasSelection: () => selected.length > 0,
        getSelection: () => selected,
        clearSelection: () => {
          cleared += 1;
          selected = '';
        },
        focus: () => { focused += 1; },
        attachCustomKeyEventHandler(handler) { keyHandler = handler; },
      },
      container,
      sendInterrupt: () => { interrupted += 1; },
      copyTextFn: async (text) => { copied.push(text); },
    });
    assert.ok(keyHandler);

    // 1. Right-click with active selection copies, clears selection, and prevents browser context menu.
    let prevented = false;
    let stopped = false;
    container.dispatchEvent(Object.assign(new dom.window.Event('contextmenu', { bubbles: true, cancelable: true }), {
      preventDefault() { prevented = true; },
      stopPropagation() { stopped = true; },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(copied, ['copied text']);
    assert.equal(cleared, 1);
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.ok(focused >= 1);

    // 2. Right-click without selection does not copy or suppress context menu.
    prevented = false;
    container.dispatchEvent(Object.assign(new dom.window.Event('contextmenu', { bubbles: true, cancelable: true }), {
      preventDefault() { prevented = true; },
      stopPropagation() {},
    }));
    assert.deepEqual(copied, ['copied text']);
    assert.equal(prevented, false);

    // 3. Ctrl+C copies when selection exists (without interrupting) and lets normal interrupt pass when empty.
    selected = 'line one';
    let copyKeyPrevented = false;
    assert.equal(keyHandler({
      type: 'keydown',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      code: 'KeyC',
      key: 'c',
      isComposing: false,
      keyCode: 67,
      preventDefault() { copyKeyPrevented = true; },
      stopPropagation() {},
    }), false);
    await Promise.resolve();
    assert.deepEqual(copied, ['copied text', 'line one']);
    assert.equal(copyKeyPrevented, true);
    assert.equal(interrupted, 0);

    // With selection cleared, Ctrl+C falls through to xterm normally (or sends \x03 directly during IME composing).
    assert.equal(keyHandler({
      type: 'keydown',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      code: 'KeyC',
      key: 'c',
      isComposing: false,
      keyCode: 67,
      preventDefault() {},
      stopPropagation() {},
    }), true);

    assert.equal(keyHandler({
      type: 'keydown',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      code: 'KeyC',
      key: 'c',
      isComposing: true,
      keyCode: 229,
      preventDefault() {},
      stopPropagation() {},
    }), false);
    assert.equal(interrupted, 1);

    // 4. Ctrl+V returns false WITHOUT preventDefault so browser triggers native paste onto xterm textarea.
    let pastePrevented = false;
    assert.equal(keyHandler({
      type: 'keydown',
      ctrlKey: true,
      altKey: false,
      metaKey: false,
      shiftKey: false,
      code: 'KeyV',
      key: 'v',
      isComposing: false,
      keyCode: 86,
      preventDefault() { pastePrevented = true; },
      stopPropagation() {},
    }), false);
    assert.equal(pastePrevented, false);

    cleanup();
  } finally {
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});

test('WorkSidebarPanel opens error dialog without creating a tab when CLI is not installed on host', async () => {
  const dom = setupDom();
  const root = createRoot(dom.document.getElementById('root'));
  const previousFetch = globalThis.fetch;
  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  const cliErrorMessage = '当前主机未安装 Antigravity（未找到命令 agy），请先安装后再试。';
  const postCalls = [];

  globalThis.fetch = async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const url = new URL(rawUrl, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.pathname === '/api/features') {
      return jsonResponse({ features: [] });
    }
    if (url.pathname === '/api/projects') {
      return jsonResponse({
        items: [{
          id: 'proj-err',
          name: 'Remote Project',
          hostId: 'local',
          directory: 'D:\\repo',
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
      });
    }
    if (url.pathname === '/api/hosts') {
      return jsonResponse({ items: [] });
    }
    if (url.pathname === '/api/work/terminals' && method === 'GET') {
      return jsonResponse({ items: [] });
    }
    if (url.pathname === '/api/work/settings') {
      return jsonResponse({
        defaultWindowsShell: 'powershell',
        activeProjectId: null,
        activeTerminals: {},
        filesPanelOpen: true,
        filesPanelWidth: null,
        persistTerminalScrollback: false,
        projectOrder: [],
        cliProviderOrder: ['codex', 'antigravity', 'claude'],
      });
    }
    if (url.pathname === '/api/projects/proj-err/cli-sessions') {
      return jsonResponse({
        projectId: 'proj-err',
        items: [],
        total: 0,
        hasMore: false,
      });
    }
    if (url.pathname === '/api/work/terminals' && method === 'POST') {
      postCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return jsonResponse({ error: { code: 'cli_not_installed', message: cliErrorMessage } }, 400);
    }
    return jsonResponse({}, 404);
  };

  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: false },
          createElement(
            PreviewContext.Provider,
            { value: false },
            createElement(WorkSidebarPanel, null),
          ),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const expandBtn = dom.document.querySelector('[aria-label="展开项目：Remote Project"]');
    assert.ok(expandBtn);
    await act(async () => {
      expandBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const addAgyBtn = dom.document.querySelector('.work-cli-group-add[data-cli-provider="antigravity"]');
    assert.ok(addAgyBtn);
    await act(async () => {
      addAgyBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].preset, 'antigravity');
    assert.equal(getWorkState().terminals.length, 0);

    const dialog = dom.document.querySelector('dialog.work-cli-error-dialog[open]');
    assert.ok(dialog);
    assert.ok(dialog.textContent.includes(cliErrorMessage));

    const closeBtn = dialog.querySelector('.dialog-footer button');
    assert.ok(closeBtn);
    await act(async () => {
      closeBtn.click();
    });
    assert.equal(dom.document.querySelector('dialog.work-cli-error-dialog[open]'), null);
  } finally {
    await act(async () => {
      root.unmount();
    });
    globalThis.fetch = previousFetch;
    resetWorkStateForTests();
    resetSidebarTabForTests();
    dom.restore();
  }
});
