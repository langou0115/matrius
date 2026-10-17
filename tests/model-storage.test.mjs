import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

import { readWorkspace, writeWorkspace, readLocalValue, writeLocalValue, LocalDataConflict } from '../src/core/database/browser-store.web.ts';
import { loadWorkspace, stripMessageImages } from '../src/features/workspace/workspace-repository.web.ts';
import { saveModelPreferences, loadModelPreferences } from '../src/features/models/model-repository.web.ts';
import { createStoredModelCredentials } from '../src/features/models/model-credential-store.web.ts';

const initial = {
  schemaVersion: 1,
  appearance: { themeId: 'twitter', mode: 'system' },
  chat: { activeId: 'chat', sidebarOpen: true, conversations: [
    { id: 'chat', title: 'Existing data', pinned: true, updatedAt: 1, messages: [{ id: 'u', role: 'user', content: 'preserve my history' }] },
  ] },
};
function requestResult(request) {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function open(version) { return requestResult(indexedDB.open('matrius', version)); }

// Single end-to-end storage sequence to exercise a real version upgrade.
test('IndexedDB v1 migrates atomically, stores only changed bodies, preserves partial replies, and rejects stale writers', async () => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  let database;
  const originalPut = IDBObjectStore.prototype.put;
  try {
    const legacy = indexedDB.open('matrius', 1);
    legacy.onupgradeneeded = () => legacy.result.createObjectStore('state');
    database = await requestResult(legacy);
    const transaction = database.transaction('state', 'readwrite');
    transaction.objectStore('state').put({ revision: 4, value: initial }, 'workspace');
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = reject; });
    database.close();
    assert.deepEqual(await readWorkspace(), { revision: 4, value: initial });
    assert.equal((await loadWorkspace()).data.chat.conversations[0].messages[0].content, 'preserve my history');
    assert.equal((await loadWorkspace()).data.chat.conversations[0].thinkingEffort, 'default', 'legacy conversations receive the default effort');
    assert.equal((await loadWorkspace()).data.chat.lastThinkingEffort, 'default', 'legacy workspaces receive the default last effort');
    assert.equal(await writeWorkspace(initial, 4), 5);
    database = await open(2);
    const metadata = await requestResult(database.transaction('state').objectStore('state').get('workspace'));
    assert.equal(metadata.value.storageVersion, 2);
    assert.ok(!JSON.stringify(metadata).includes('preserve my history'));
    assert.deepEqual((await readWorkspace()).value, initial);
    let messageWrites = 0;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'messages') messageWrites++; return originalPut.apply(this, args); };
    const next = structuredClone(initial);
    next.chat.conversations[0].messages.push({ id: 'a', role: 'assistant', content: 'partial', reasoning: 'visible provider reasoning', thinkingMs: 4200, status: 'streaming' });
    await writeWorkspace(next, 5);
    assert.equal(messageWrites, 1);
    messageWrites = 0;
    next.chat.conversations[0].messages[1].content += ' reply';
    await writeWorkspace(next, 6);
    assert.equal(messageWrites, 1, 'unchanged user message must not be rewritten');
    const restored = await loadWorkspace();
    assert.equal(restored.data.chat.conversations[0].messages[1].content, 'partial reply');
    assert.equal(restored.data.chat.conversations[0].messages[1].status, 'stopped');
    assert.equal(restored.data.chat.conversations[0].messages[1].thinkingMs, 4200, 'thinking duration survives a reload');
    assert.equal(restored.data.chat.conversations[0].messages[0].thinkingMs, undefined, 'messages without a measured duration stay undefined');
    const stale = structuredClone(initial);
    await assert.rejects(writeWorkspace(stale, 5), LocalDataConflict);
    assert.equal((await readWorkspace()).value.chat.conversations[0].messages[1].content, 'partial reply');
    const outcomes = await Promise.allSettled([writeWorkspace(next, 7), writeWorkspace(stale, 7)]);
    assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(value => value.status === 'rejected').length, 1);
    const beforeEffort = await loadWorkspace();
    const withEffort = structuredClone(beforeEffort.data);
    withEffort.chat.conversations[0].thinkingEffort = 'high';
    withEffort.chat.lastThinkingEffort = 'high';
    await writeWorkspace(withEffort, beforeEffort.revision);
    const effortRestored = await loadWorkspace();
    assert.equal(effortRestored.data.chat.conversations[0].thinkingEffort, 'high');
    assert.equal(effortRestored.data.chat.lastThinkingEffort, 'high');
    const config = { id: 'model', name: 'Model', modelId: 'test', protocol: 'completion', baseUrl: 'https://test.invalid/v1', contextWindow: 10000, maxOutput: 1000, requiresApiKey: true, apiKey: 'never-store-this' };
    await saveModelPreferences({ models: [config], selectedId: 'model' }, 0);
    assert.equal((await loadModelPreferences()).data.selectedId, 'model');
    assert.ok(!JSON.stringify(await readLocalValue('model-preferences')).includes('never-store-this'));
    await assert.rejects(saveModelPreferences({ models: [], selectedId: null }, 0), LocalDataConflict);
    assert.equal(await writeLocalValue('other-key', { value: 1 }, 0), 1);
    assert.equal((await readLocalValue('other-key')).value.value, 1);
    const latest = await readWorkspace();
    const deleted = structuredClone(initial);
    deleted.chat.conversations = []; deleted.chat.activeId = null;
    await writeWorkspace(deleted, latest.revision);
    const bodies = await requestResult(database.transaction('messages').objectStore('messages').getAllKeys());
    assert.deepEqual(bodies, []);
  } finally {
    IDBObjectStore.prototype.put = originalPut;
    database?.close();
    globalThis.indexedDB = previous;
  }
});

test('attached image bytes never reach the persisted workspace', () => {
  const conversations = [{
    id: 'chat', title: '看图', pinned: false, updatedAt: 1,
    messages: [{ id: 'u', role: 'user', content: '这是什么？', images: [
      { id: 'img', name: 'dot.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,SECRET-PIXELS' },
    ] }],
  }];
  const stripped = stripMessageImages(conversations);
  assert.equal(stripped[0].messages[0].content, '这是什么？', 'the text survives');
  assert.equal(stripped[0].messages[0].images, undefined, 'the image is dropped');
  assert.ok(!JSON.stringify(stripped).includes('SECRET-PIXELS'));
  assert.deepEqual(stripMessageImages([]), []);
});

test('API keys persist in their own record and never reach the synced metadata', async () => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = new IDBFactory();
  try {
    const vault = createStoredModelCredentials();
    await vault.load();
    await vault.set('provider-1', '  browser-key  ');
    assert.equal(vault.get('provider-1'), 'browser-key', 'keys are trimmed before storage');
    assert.deepEqual((await readLocalValue('model-credentials')).value, { keys: { 'provider-1': 'browser-key' } });

    const reloaded = createStoredModelCredentials();
    await reloaded.load();
    assert.equal(reloaded.get('provider-1'), 'browser-key', 'a new page restores saved keys');
    assert.equal(reloaded.get('provider-2'), '');

    const metadata = await readLocalValue('model-preferences');
    await saveModelPreferences({ providers: [{ id: 'provider-1', name: 'Provider', protocol: 'completion', baseUrl: 'https://test.invalid/v1', requiresApiKey: true, models: [] }], selectedId: null }, metadata?.revision ?? 0);
    assert.equal((await loadModelPreferences()).data.providers[0].id, 'provider-1');
    assert.ok(!JSON.stringify(await readLocalValue('model-preferences')).includes('browser-key'), 'metadata stays key-free');

    const stale = createStoredModelCredentials();
    await stale.load();
    await vault.set('provider-1', 'second-key');
    await assert.rejects(() => stale.set('provider-2', 'lost-key'), /刷新后重试/, 'a stale page surfaces the conflict instead of dropping other keys');

    const reopened = createStoredModelCredentials();
    await reopened.load();
    assert.equal(reopened.get('provider-1'), 'second-key');
    await reopened.delete('provider-1');
    assert.equal(reopened.get('provider-1'), '');
    const cleared = createStoredModelCredentials();
    await cleared.load();
    assert.equal(cleared.get('provider-1'), '', 'deleting the provider removes the stored key');
  } finally {
    globalThis.indexedDB = previous;
  }
});
