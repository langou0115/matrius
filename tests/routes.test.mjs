import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { parseHTML } from 'linkedom';
import { IDBFactory } from 'fake-indexeddb';

// Every route must mount without the error boundary taking over. The navigation module is
// stubbed by the test loader, so this checks the route table and screen imports only.
test('every route renders a screen instead of the error boundary', { timeout: 30000 }, async () => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLElement = window.HTMLElement;
  window.HTMLElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLElement.prototype.close = function () { this.removeAttribute('open'); };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.indexedDB = new IDBFactory();
  globalThis.__DEV__ = true;
  // linkedom has neither API; both are only needed for layout measurement.
  globalThis.ResizeObserver = window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
  globalThis.fetch = async (url) => {
    const path = String(url);
    let data = { items: [], nextCursor: null };
    if (path === '/api/features') data = { features: [{ id: 'files' }, { id: 'usage' }, { id: 'tasks' }] };
    if (path === '/api/models') data = { providers: [], selectedId: null, titleModelId: null, memoryModelId: null, configuredKeyProviderIds: [], revision: 1 };
    if (path === '/api/preferences') data = { themeId: 'twitter', mode: 'system', revision: 1 };
    if (path === '/api/profile') data = { customInstructions: '', aboutName: '', occupation: '', aboutMore: '', revision: 1 };
    if (path.startsWith('/api/profile/fields/')) data = { value: '{}', revision: 1 };
    if (path === '/api/files/usage') data = { used: 0, disk: { total: 1000, used: 600, free: 400 } };
    if (path.startsWith('/api/usage')) data = { items: [], lifetime: { total: 0 }, estimated: { total: 0 }, backfilled: true };
    if (path === '/api/work/settings') {
      data = {
        defaultWindowsShell: 'powershell',
        activeProjectId: null,
        activeTerminals: {},
        filesPanelOpen: true,
        filesPanelWidth: null,
        persistTerminalScrollback: false,
        editorFontSize: 14,
        editorAutoSave: false,
        editorDiffLayout: 'inline',
        projectOrder: [],
        cliProviderOrder: ['codex', 'antigravity', 'claude'],
        terminalOrder: [],
      };
    }
    return Response.json(data);
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');
  const { AppRoutes } = await import('../ui/router/routes.tsx');

  function isRouteReady(container) {
    if (container.innerHTML.length <= 500) return false;
    const content = container.querySelector('.workspace-content');
    return !content || content.innerHTML.length > 0;
  }

  async function waitForRoute(container, timeoutMs = 120) {
    const deadline = Date.now() + timeoutMs;
    while (!isRouteReady(container) && Date.now() < deadline) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    await act(async () => { await Promise.resolve(); });
  }

  for (const path of ['/', '/c/example', '/work', '/p/example', '/library', '/tasks', '/settings', '/settings/appearance', '/settings/models',
    '/settings/work-general', '/settings/work-editor', '/settings/hosts', '/settings/personalization', '/settings/account', '/settings/storage', '/settings/usage', '/settings/about',
    '/admin', '/debug', '/debug?tab=tools', '/mock/chat', '/mock/chat/work', '/mock/chat/p/example', '/mock/chat/settings/appearance', '/mock/chat/settings/work-general', '/mock/chat/settings/work-editor', '/mock/chat/settings/hosts', '/mock/library', '/mock/tasks', '/mock/process', '/mock/storage']) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AppRoutes)));
      });
      await waitForRoute(container);
      const html = container.innerHTML;
      assert.ok(html.length > 500, `${path} rendered ${html.length} bytes`);
      assert.doesNotMatch(html, /界面渲染失败/u, `${path} must not hit the error boundary`);
      assert.doesNotMatch(html, /登录以访问|前往登录/u);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  }

  globalThis.__MATRIUS_TARGET__ = 'desktop';
  try {
    for (const path of ['/work', '/p/example', '/mock/chat/work', '/mock/chat/p/example']) {
      const container = document.createElement('div');
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AppRoutes)));
        });
        await waitForRoute(container);
        const html = container.innerHTML;
        assert.ok(html.length > 500, `desktop ${path} rendered ${html.length} bytes`);
        assert.doesNotMatch(html, /界面渲染失败/u, `desktop ${path} must not hit the error boundary`);
      } finally {
        await act(async () => { root.unmount(); });
        container.remove();
      }
    }
  } finally {
    globalThis.__MATRIUS_TARGET__ = undefined;
  }
});
