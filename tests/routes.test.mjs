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
    if (path === '/api/features') data = { features: [{ id: 'files' }, { id: 'usage' }] };
    if (path === '/api/preferences') data = { themeId: 'twitter', mode: 'system', revision: 1 };
    if (path === '/api/profile') data = { customInstructions: '', aboutName: '', occupation: '', aboutMore: '', revision: 1 };
    if (path.startsWith('/api/profile/fields/')) data = { value: '{}', revision: 1 };
    if (path === '/api/files/usage') data = { used: 0, disk: { total: 1000, used: 600, free: 400 } };
    if (path.startsWith('/api/usage')) data = { items: [], lifetime: { total: 0 }, estimated: { total: 0 }, backfilled: true };
    return Response.json(data);
  };

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await import('react-router-dom');
  const { AppRoutes } = await import('../src/router/routes.tsx');

  for (const path of ['/', '/c/example', '/library', '/settings', '/settings/appearance', '/settings/models',
    '/settings/personalization', '/settings/account', '/settings/storage', '/settings/usage', '/settings/about',
    '/admin', '/mock', '/mock/chat', '/mock/chat/settings/appearance', '/mock/library', '/mock/process', '/mock/storage']) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(MemoryRouter, { initialEntries: [path] }, createElement(AppRoutes)));
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 120)); });
      const html = container.innerHTML;
      assert.ok(html.length > 500, `${path} rendered ${html.length} bytes`);
      assert.doesNotMatch(html, /界面渲染失败/u, `${path} must not hit the error boundary`);
      assert.doesNotMatch(html, /登录以访问|前往登录/u);
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  }
});
