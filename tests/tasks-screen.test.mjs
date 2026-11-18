import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { parseHTML } from 'linkedom';
import { IDBFactory } from 'fake-indexeddb';

test('tasks screen renders library-style rows, 4 status tabs, search, status toggle, and menu with conversation check', { timeout: 30000 }, async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    indexedDB: globalThis.indexedDB,
    dev: globalThis.__DEV__,
    ResizeObserver: globalThis.ResizeObserver,
    fetch: globalThis.fetch,
  };

  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.indexedDB = new IDBFactory();
  globalThis.__DEV__ = true;
  globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  globalThis.fetch = async () => Response.json({});

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { InstanceProvider } = await import('../ui/features/instance/instance-state.tsx');
  const { InstanceWorkspace } = await import('../ui/components/web/instance-workspace.tsx');
  const { default: TasksScreen } = await import('../ui/features/tasks/tasks-screen.tsx');

  const rootElement = document.getElementById('root');
  const root = createRoot(rootElement);
  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: true },
          createElement(InstanceWorkspace, { preview: true }, createElement(TasksScreen)),
        ),
      );
    });

    // All 5 mock tasks render in single rows with NO icon artwork and NO direct conversation jump button inside the row.
    const rows = document.querySelectorAll('.task-row');
    assert.equal(rows.length, 5);
    assert.equal(document.querySelectorAll('.task-card').length, 0);
    assert.equal(document.querySelectorAll('.task-row-conv').length, 0);
    assert.equal(document.querySelectorAll('.task-row-artwork').length, 0);

    // Four category tabs: 已开启, 已暂停, 已结束, 全部.
    const tabButtons = Array.from(document.querySelectorAll('[aria-label="任务状态"] .library-kind'));
    assert.deepEqual(tabButtons.map((button) => button.textContent.trim()), ['已开启', '已暂停', '已结束', '全部']);

    await act(async () => { tabButtons[0].click(); });
    assert.equal(document.querySelectorAll('.task-row').length, 3);
    await act(async () => { tabButtons[1].click(); });
    assert.equal(document.querySelectorAll('.task-row').length, 1);
    await act(async () => { tabButtons[2].click(); });
    assert.equal(document.querySelectorAll('.task-row').length, 1);
    await act(async () => { tabButtons[3].click(); });
    assert.equal(document.querySelectorAll('.task-row').length, 5);

    // Search filters by title/prompt.
    const searchInput = document.querySelector('.library-search input');
    assert.ok(searchInput);
    const propsKey = Object.keys(searchInput).find((key) => key.startsWith('__reactProps'));
    assert.ok(propsKey);
    await act(async () => {
      searchInput.value = 'GitHub';
      searchInput[propsKey].onChange({ target: searchInput });
    });
    assert.equal(document.querySelectorAll('.task-row').length, 1);

    // Clear search restores all rows.
    const clearButton = document.querySelector('button[aria-label="清空搜索"]');
    assert.ok(clearButton);
    await act(async () => { clearButton.click(); });
    assert.equal(document.querySelectorAll('.task-row').length, 5);

    // Status button toggles 已开启 <-> 已暂停.
    const firstStatusButton = document.querySelector('.task-row .task-status-btn');
    assert.ok(firstStatusButton);
    assert.match(firstStatusButton.textContent, /已开启/);
    await act(async () => { firstStatusButton.click(); });
    assert.match(firstStatusButton.textContent, /已暂停/);

    // Three-dots menu exposes 开启/暂停, 查看关联对话/关联对话, 编辑, 立即执行, 删除.
    const moreButtons = document.querySelectorAll('.task-row .task-row-more');
    assert.ok(moreButtons[0]);
    await act(async () => { moreButtons[0].click(); });
    const menuItems = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map((node) => node.textContent.trim());
    assert.ok(menuItems.includes('开启'));
    assert.ok(menuItems.includes('查看关联对话'));
    assert.ok(menuItems.includes('编辑'));
    assert.ok(menuItems.includes('立即执行'));
    assert.ok(menuItems.includes('删除'));

    // Task 2 has no conversationClientId; clicking 查看关联对话 opens the提示弹窗.
    await act(async () => { moreButtons[1].click(); });
    const noConvItem = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
      .find((node) => node.textContent.trim() === '查看关联对话');
    assert.ok(noConvItem);
    await act(async () => { noConvItem.click(); });
    const dialog = document.querySelector('dialog[open]');
    assert.ok(dialog);
    assert.match(dialog.textContent, /没有关联对话，需要第一次执行后才会创建并关联/);
    await act(async () => { dialog.querySelector('button')?.click(); });

    // Empty search / empty state shows the centered SVG illustration without suggestions.
    await act(async () => {
      searchInput.value = '不存在的任务名称';
      searchInput[propsKey].onChange({ target: searchInput });
    });
    assert.equal(document.querySelectorAll('.task-row').length, 0);
    assert.equal(document.querySelectorAll('.task-suggestion-row').length, 0);
    assert.ok(document.querySelector('.tasks-empty-illustration'));
    assert.match(document.querySelector('.tasks-placeholder-text')?.textContent ?? '', /没有找到匹配的定时任务/);

    // Clear search and test batch selection + batch delete of 2 tasks.
    const clearButton2 = document.querySelector('button[aria-label="清空搜索"]');
    assert.ok(clearButton2);
    await act(async () => { clearButton2.click(); });
    const rowMainButtons = document.querySelectorAll('.task-row-main');
    assert.equal(rowMainButtons.length, 5);
    await act(async () => {
      rowMainButtons[0].click();
      rowMainButtons[1].click();
    });
    const batchDeleteBtn = document.querySelector('.library-delete-selected');
    assert.ok(batchDeleteBtn);
    await act(async () => { batchDeleteBtn.click(); });
    const batchDialog = document.querySelector('dialog[open]');
    assert.ok(batchDialog);
    assert.match(batchDialog.textContent, /删除 2 个定时任务/);
    await act(async () => {
      batchDialog.querySelector('.danger-button')?.click();
    });
    assert.equal(document.querySelectorAll('.task-row').length, 3);

    // Switching to an empty status tab while tasks exist does not show a 查看全部 button.
    for (const statusBtn of document.querySelectorAll('.task-row .task-status-btn')) {
      if (statusBtn.textContent?.includes('已暂停')) {
        await act(async () => { statusBtn.click(); });
      }
    }
    await act(async () => { tabButtons[1].click(); });
    assert.equal(document.querySelectorAll('.task-row').length, 0);
    assert.match(document.querySelector('.tasks-placeholder-text')?.textContent ?? '', /没有已暂停的定时任务/);
    assert.equal(document.querySelectorAll('.tasks-placeholder-actions').length, 0);
    assert.equal(
      Array.from(document.querySelectorAll('.tasks-placeholder button')).some((btn) => btn.textContent?.includes('查看全部')),
      false,
    );
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.Node = previous.Node;
    globalThis.Event = previous.Event;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    globalThis.indexedDB = previous.indexedDB;
    globalThis.__DEV__ = previous.dev;
    globalThis.ResizeObserver = previous.ResizeObserver;
    globalThis.fetch = previous.fetch;
  }
});

test('tasks screen renders clean empty state without suggestions when there are no tasks', { timeout: 30000 }, async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    indexedDB: globalThis.indexedDB,
    dev: globalThis.__DEV__,
    ResizeObserver: globalThis.ResizeObserver,
    fetch: globalThis.fetch,
  };

  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.indexedDB = new IDBFactory();
  globalThis.__DEV__ = true;
  globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    let data = { items: [], nextCursor: null };
    if (path === '/api/features') data = { features: [{ id: 'tasks' }] };
    if (path === '/api/preferences') data = { themeId: 'twitter', mode: 'system', revision: 1 };
    if (path === '/api/profile') data = { customInstructions: '', aboutName: '', occupation: '', aboutMore: '', revision: 1 };
    if (path.startsWith('/api/profile/fields/')) data = { value: '{}', revision: 1 };
    if (path === '/api/tasks') data = { items: [] };
    return Response.json(data);
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { InstanceProvider } = await import('../ui/features/instance/instance-state.tsx');
  const { InstanceWorkspace } = await import('../ui/components/web/instance-workspace.tsx');
  const { default: TasksScreen } = await import('../ui/features/tasks/tasks-screen.tsx');

  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: false },
          createElement(InstanceWorkspace, { preview: false }, createElement(TasksScreen)),
        ),
      );
    });
    for (let attempt = 0; attempt < 20 && !document.querySelector('.tasks-empty-illustration'); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    }
    assert.ok(document.querySelector('.tasks-empty-illustration'));
    assert.equal(document.querySelectorAll('.task-suggestion-row').length, 0);
    assert.match(document.querySelector('.tasks-placeholder-text')?.textContent ?? '', /还没有定时任务/);

    const activeTab = Array.from(document.querySelectorAll('[aria-label="任务状态"] .library-kind'))
      .find((button) => button.textContent.trim() === '已开启');
    assert.ok(activeTab);
    await act(async () => { activeTab.click(); });
    assert.match(document.querySelector('.tasks-placeholder-text')?.textContent ?? '', /没有已开启的定时任务/);
  } finally {
    await act(async () => { root.unmount(); });
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.Node = previous.Node;
    globalThis.Event = previous.Event;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    globalThis.indexedDB = previous.indexedDB;
    globalThis.__DEV__ = previous.dev;
    globalThis.ResizeObserver = previous.ResizeObserver;
    globalThis.fetch = previous.fetch;
  }
});

test('mobile tasks hide row settings button and open settings card on long press', { timeout: 30000 }, async (t) => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    Event: globalThis.Event,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    indexedDB: globalThis.indexedDB,
    dev: globalThis.__DEV__,
    ResizeObserver: globalThis.ResizeObserver,
    fetch: globalThis.fetch,
  };

  const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.Event = window.Event;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList?.contains('task-row')) {
      return { left: 20, right: 370, top: 20, bottom: 80, width: 350, height: 60 };
    }
    if (this.classList?.contains('task-row-main')) {
      return { left: 20, right: 260, top: 24, bottom: 76, width: 240, height: 52 };
    }
    return { left: 0, right: 148, top: 0, bottom: 140, width: 148, height: 140 };
  };
  window.HTMLElement.prototype.focus = () => {};
  window.innerWidth = 390;
  window.innerHeight = 800;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.indexedDB = new IDBFactory();
  globalThis.__DEV__ = true;
  globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = (query) => ({
    matches: query === '(max-width: 767px)',
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  globalThis.fetch = async () => Response.json({});

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { InstanceProvider } = await import('../ui/features/instance/instance-state.tsx');
  const { InstanceWorkspace } = await import('../ui/components/web/instance-workspace.tsx');
  const { default: TasksScreen } = await import('../ui/features/tasks/tasks-screen.tsx');

  const root = createRoot(document.getElementById('root'));
  const dispatchPointer = (target, type, properties = {}) => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { isPrimary: true, button: 0, clientX: 20, clientY: 20, detail: 1 }, properties);
    target.dispatchEvent(event);
  };

  try {
    await act(async () => {
      root.render(
        createElement(
          InstanceProvider,
          { preview: true },
          createElement(InstanceWorkspace, { preview: true }, createElement(TasksScreen)),
        ),
      );
    });

    assert.equal(document.querySelectorAll('.task-row-more').length, 0);
    assert.equal(document.querySelectorAll('.task-row .task-status-btn').length, 5);

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const firstRowMain = document.querySelector('.task-row-main');
    assert.ok(firstRowMain);

    // Dragging cancels long press.
    await act(async () => {
      dispatchPointer(firstRowMain, 'pointerdown');
      dispatchPointer(firstRowMain, 'pointermove', { clientY: 60 });
      t.mock.timers.tick(500);
      dispatchPointer(firstRowMain, 'pointercancel');
    });
    assert.equal(document.querySelector('[role="menu"]'), null);

    // Holding 500ms opens the settings menu card.
    await act(async () => {
      dispatchPointer(firstRowMain, 'pointerdown');
      t.mock.timers.tick(500);
    });
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu);
    assert.equal(menu.style.left, `${370 - 148}px`);
    assert.equal(menu.style.top, '86px');
    const menuItems = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((node) => node.textContent.trim());
    assert.ok(menuItems.includes('暂停'));
    assert.ok(menuItems.includes('查看关联对话'));
    assert.ok(menuItems.includes('编辑'));
    assert.ok(menuItems.includes('删除'));

    // Releasing after long press (including native contextmenu / pointerup / click) must keep the menu open.
    await act(async () => {
      dispatchPointer(firstRowMain, 'contextmenu');
      dispatchPointer(firstRowMain, 'pointerup');
      dispatchPointer(firstRowMain, 'click');
    });
    assert.ok(document.querySelector('[role="menu"]'));

    // Tapping outside dismisses the menu.
    await act(async () => {
      dispatchPointer(document.body, 'pointerdown');
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally {
    await act(async () => { root.unmount(); });
    t.mock.timers.reset();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.HTMLElement = previous.HTMLElement;
    globalThis.Node = previous.Node;
    globalThis.Event = previous.Event;
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    globalThis.indexedDB = previous.indexedDB;
    globalThis.__DEV__ = previous.dev;
    globalThis.ResizeObserver = previous.ResizeObserver;
    globalThis.fetch = previous.fetch;
  }
});
