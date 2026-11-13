import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resumeHref } from '../ui/features/chat/conversation-route-state.ts';
import { readLastRouteId, writeLastRoute } from '../ui/features/chat/last-conversation.ts';

const conversations = [{ id: 'a' }, { id: 'b' }];

test('a bare root opens the conversation the workspace left off in at its own URL', () => {
  assert.equal(resumeHref('/', 'b', conversations), '/c/b');
});

test('the conversation id is encoded in the resumed URL', () => {
  assert.equal(resumeHref('/', 'a b', [{ id: 'a b' }]), '/c/a%20b');
});

test('a URL that already names a page is left alone', () => {
  assert.equal(resumeHref('/c/a', 'b', conversations), null);
  assert.equal(resumeHref('/settings', 'b', conversations), null);
});

test('a new conversation (no active id) stays on the empty screen', () => {
  assert.equal(resumeHref('/', null, conversations), null);
});

test('a remembered conversation that was deleted elsewhere is not reopened', () => {
  assert.equal(resumeHref('/', 'missing', conversations), null);
});

test('the page mirror survives independently of the saved workspace', () => {
  const entries = new Map();
  globalThis.localStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: (key) => { entries.delete(key); },
  };
  try {
    writeLastRoute('a b');
    assert.equal(readLastRouteId(), 'a b');
    assert.equal(entries.get('matrius.last-route'), '/c/a%20b');
    writeLastRoute(null);
    assert.equal(readLastRouteId(), null);
    // Only conversation pages are a valid resume target.
    entries.set('matrius.last-route', '/settings');
    assert.equal(readLastRouteId(), null);
    entries.set('matrius.last-route', '/c/');
    assert.equal(readLastRouteId(), null);
  } finally {
    delete globalThis.localStorage;
  }
});
