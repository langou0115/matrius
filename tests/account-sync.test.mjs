import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { IDBFactory } from 'fake-indexeddb';

import { AuthProvider, useAuth } from '../src/features/auth/auth-state.tsx';
import { LocalWorkspace } from '../src/components/web/local-workspace.tsx';
import { useChat } from '../src/features/chat/chat-state.tsx';
import { useNetworkTools } from '../src/features/auth/network-tools-state.tsx';
import { useModels } from '../src/features/models/model-state.tsx';
import { readWorkspace, writeWorkspace } from '../src/core/database/browser-store.ts';

// Exercise the real provider tree: account changes must replace every workspace state
// while retaining the same browser model configuration and credential vault.
test('login and account changes isolate workspaces while models and keys stay local and shared', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT, dev: globalThis.__DEV__ };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.indexedDB = new IDBFactory();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__DEV__ = false;
  const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  const user = id => ({ id, username: id, isAdmin: false, mustChangePassword: false, features: [] });
  const calls = [];
  // The web client authenticates with an HttpOnly cookie. This mock keeps the session
  // out of JS, mirroring what the browser would send back on each same-origin request.
  let signedIn = null;
  const unauthorized = () => new Response(
    JSON.stringify({ error: { code: 'unauthorized', message: '请重新登录。' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } },
  );
  globalThis.fetch = async (path, init) => {
    calls.push({ path, init });
    assert.equal(init.credentials, 'include');
    assert.equal(new Headers(init.headers).get('Authorization'), null);
    if (path === '/api/auth/login') {
      signedIn = JSON.parse(init.body).username;
      return response({ token: signedIn, user: user(signedIn) });
    }
    if (path === '/api/auth/logout') { signedIn = null; return response({ ok: true }); }
    if (!signedIn) return unauthorized();
    const id = signedIn;
    if (path === '/api/auth/me') return response(user(id));
    if (path === '/api/preferences') return response({ themeId: 'twitter', mode: 'system', revision: 1 });
    if (path === '/api/profile') return response({ revision: 1 });
    if (path === '/api/profile/fields/memory') return new Response(
      JSON.stringify({ error: { code: 'not_found', message: '记忆字段不存在。' } }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    );
    if (path.startsWith('/api/conversations?')) return response({ items: [{
      id: `${id}-chat`, title: id, pinned: false, revision: 1, updatedAt: 1,
      readState: { completed: { state: 'absent' }, error: { state: 'absent' } },
    }], nextCursor: null });
    if (path.startsWith('/api/conversations/')) return response({ messages: [], nextCursor: null });
    throw new Error(`Unexpected request ${path}`);
  };
  let chat, auth, models, network;
  function Harness() { chat = useChat(); auth = useAuth(); models = useModels(); network = useNetworkTools(); return null; }
  const root = createRoot(document.getElementById('root'));
  async function until(predicate) {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    assert.ok(predicate(), 'workspace must finish loading');
  }
  try {
    const initial = { schemaVersion: 1, appearance: { themeId: 'twitter', mode: 'system' },
      chat: { conversations: [{ id: 'local-chat', title: 'Local', pinned: false, updatedAt: 1, messages: [] }], activeId: null, sidebarOpen: true } };
    await writeWorkspace(initial, 0);
    await act(async () => root.render(createElement(AuthProvider, { preview: false },
      createElement(LocalWorkspace, { preview: false }, createElement(Harness)))));
    await until(() => models?.ready && chat?.conversations[0]?.id === 'local-chat');
    await act(async () => models.saveProvider({ id: 'provider', name: 'Local model', protocol: 'completion',
      baseUrl: 'https://example.com/v1', requiresApiKey: true, models: [{ id: 'model', name: 'Model', modelId: 'example', supportsImage: false, contextWindow: 10000, maxOutput: 1000 }] }, 'local-test-key'));
    await until(() => models.providers.length === 1);
    const localBefore = await readWorkspace();
    const modelApi = models.getKey;
    await act(async () => { await auth.login('alice', 'test-password'); });
    await until(() => chat.conversations[0]?.id === 'alice-chat' && network.ready);
    assert.equal(models.selectedId, 'model');
    assert.equal(models.getKey('provider'), 'local-test-key');
    await act(async () => { await auth.refresh(); });
    assert.equal(chat.conversations[0].id, 'alice-chat');
    assert.equal(models.getKey('provider'), 'local-test-key');
    await act(async () => { await auth.login('bob', 'test-password'); });
    await until(() => chat.conversations[0]?.id === 'bob-chat' && network.ready);
    assert.equal(models.getKey('provider'), 'local-test-key');
    assert.equal(modelApi('provider'), 'local-test-key', 'the credential vault survives workspace remounts');
    assert.deepEqual(await readWorkspace(), localBefore, 'cloud mode must not write IndexedDB workspace data');
    assert.ok(calls.every(({ path }) => !path.includes('/import')));
    assert.ok(!JSON.stringify(calls).includes('local-test-key'), 'cloud requests must never carry model keys');
    await act(async () => { await auth.logout(); });
    await until(() => chat.conversations[0]?.id === 'local-chat');
    assert.equal(models.selectedId, 'model');
    assert.equal(models.getKey('provider'), 'local-test-key');
  } finally {
    // Let pending preference loads land while the fake window still exists; a late
    // setState after the globals are restored reads through an undefined `window`.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await act(async () => root.unmount());
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.indexedDB = previous.indexedDB;
    globalThis.fetch = previous.fetch; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act; globalThis.__DEV__ = previous.dev;
  }
});
