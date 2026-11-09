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
  // Unauthenticated: screens must still render their signed-out state.
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { code: 'unauthorized', message: 'unauthenticated' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );

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
      if (!path.startsWith('/mock')) {
        assert.match(html, /登录以访问你的单用户实例/u, `${path} must require instance login`);
        assert.equal(container.querySelector('.composer'), null, 'signed-out visitors cannot mount the chat runtime');
      }
    } finally {
      await act(async () => { root.unmount(); });
      container.remove();
    }
  }
});
