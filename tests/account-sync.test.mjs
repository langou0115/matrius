import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { IDBFactory } from 'fake-indexeddb';

import { AuthProvider, useAuth } from '../src/features/auth/auth-state.web.tsx';
import { AccountSyncProvider, useAccountSync } from '../src/features/auth/account-sync-state.web.tsx';
import { ChatProvider, useChat } from '../src/features/chat/chat-state.tsx';
import { PersonalizationProvider } from '../src/features/settings/personalization-state.tsx';
import { AppearanceProvider } from '../src/theme/appearance.tsx';

test('deleting during an upload immediately queues another sync and never renders the late remote copy', async () => {
  const previous = { window: globalThis.window, document: globalThis.document, indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  globalThis.window = window; globalThis.document = document; globalThis.indexedDB = new IDBFactory();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const uploads = [];
  const tombstones = new Set();
  let release;
  const firstUpload = new Promise(resolve => { release = resolve; });
  const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  const old = { id: 'deleted', title: 'old', pinned: false, updatedAt: 1, messages: [] };
  globalThis.fetch = async (path, init) => {
    if (path === '/api/auth/login') return response({ token: 'test-token', user: {
      id: 'alice', username: 'alice', isAdmin: false, mustChangePassword: false, features: [],
    } });
    if (path === '/api/account/import') {
      const payload = JSON.parse(init.body);
      uploads.push(payload);
      if (uploads.length === 1) await firstUpload;
      for (const id of payload.chat.deletedConversationIds ?? []) tombstones.add(id);
      return response({});
    }
    if (path.startsWith('/api/account/conversation-deletions')) return response({ items: [...tombstones] });
    if (path.startsWith('/api/conversations?')) return response({ items: tombstones.size ? [] : [{ ...old, clientId: old.id }] });
    throw new Error(`Unexpected request ${path}`);
  };
  let chat, auth, sync;
  function Harness() { chat = useChat(); auth = useAuth(); sync = useAccountSync(); return null; }
  const root = createRoot(document.getElementById('root'));
  async function until(predicate) {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    }
    assert.ok(predicate(), 'condition must complete without waiting for the 60-second debounce');
  }
  try {
    await act(async () => root.render(createElement(AuthProvider, { preview: true },
      createElement(AppearanceProvider, null, createElement(PersonalizationProvider, null,
        createElement(ChatProvider, { initialState: { conversations: [old], activeId: old.id, sidebarOpen: true } },
          createElement(AccountSyncProvider, { preview: false }, createElement(Harness))))))));
    await act(async () => { await auth.login('alice', 'test-password'); });
    await until(() => uploads.length === 1);
    await act(async () => { chat.dispatch({ type: 'delete', id: old.id }); });
    assert.deepEqual(chat.conversations, []);
    await act(async () => { release(); });
    await until(() => tombstones.has(old.id) && sync.phase === 'done');
    assert.deepEqual(uploads[1].chat.deletedConversationIds, [old.id]);
    assert.deepEqual(chat.conversations, []);
    assert.deepEqual(chat.deletedConversationIds, [old.id]);
    assert.equal(sync.error, null);
  } finally {
    release();
    await act(async () => root.unmount());
    globalThis.window = previous.window; globalThis.document = previous.document; globalThis.indexedDB = previous.indexedDB;
    globalThis.fetch = previous.fetch; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
  }
});
