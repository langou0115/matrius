import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

type Json = Record<string, unknown>;

async function withApp(fn: (app: Awaited<ReturnType<typeof buildApp>>['app']) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-workspace-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
  });
  const { app } = await buildApp({ settings });
  try {
    await fn(app);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function body<T = Json>(response: { json: () => unknown }): T {
  return response.json() as T;
}

test('preferences and profile are created on first read and use revisions', async () => {
  await withApp(async (app) => {
    const preferences = await app.inject({ method: 'GET', url: '/api/preferences' });
    assert.equal(preferences.statusCode, 200);
    assert.deepEqual(body(preferences), { themeId: 'twitter', mode: 'system', revision: 1 });

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      payload: { baseRevision: 1, themeId: 'nord', mode: 'dark' },
    });
    assert.equal(updated.statusCode, 200);
    assert.deepEqual(body(updated), { themeId: 'nord', mode: 'dark', revision: 2 });

    const stale = await app.inject({
      method: 'PUT',
      url: '/api/preferences',
      payload: { baseRevision: 1, themeId: 'other', mode: 'light' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(body<{ error: { current: { revision: number } } }>(stale).error.current.revision, 2);

    const profile = await app.inject({ method: 'GET', url: '/api/profile' });
    assert.equal(profile.statusCode, 200);
    assert.deepEqual(body(profile), {
      customInstructions: '',
      aboutName: '',
      occupation: '',
      aboutMore: '',
      revision: 1,
    });

    const profileUpdated = await app.inject({
      method: 'PUT',
      url: '/api/profile',
      payload: {
        baseRevision: 1,
        customInstructions: 'Be concise.',
        aboutName: 'Mat',
        occupation: 'Engineer',
        aboutMore: 'Works on Matrius.',
      },
    });
    assert.equal(profileUpdated.statusCode, 200);
    assert.equal(body(profileUpdated).revision, 2);
    assert.equal(body(profileUpdated).customInstructions, 'Be concise.');
  });
});

test('profile fields upsert, conflict, list and delete', async () => {
  await withApp(async (app) => {
    const empty = await app.inject({ method: 'GET', url: '/api/profile/fields' });
    assert.deepEqual(body(empty), { items: [] });

    const created = await app.inject({
      method: 'PUT',
      url: '/api/profile/fields/memory',
      payload: { value: '{"enabled":true}', source: 'manual', updatedAt: 123 },
    });
    assert.equal(created.statusCode, 200);
    assert.deepEqual(body(created), {
      key: 'memory',
      value: '{"enabled":true}',
      source: 'manual',
      updatedAt: 123,
      revision: 1,
    });

    const single = await app.inject({ method: 'GET', url: '/api/profile/fields/memory' });
    assert.equal(body(single).revision, 1);

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/profile/fields/memory',
      payload: { baseRevision: 1, value: '{"enabled":false}', source: 'tool' },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(body(updated).revision, 2);

    const conflict = await app.inject({
      method: 'PUT',
      url: '/api/profile/fields/memory',
      payload: { baseRevision: 1, value: 'stale' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(body<{ error: { current: { revision: number } } }>(conflict).error.current.revision, 2);

    const list = await app.inject({ method: 'GET', url: '/api/profile/fields' });
    assert.equal(body<{ items: Json[] }>(list).items.length, 1);

    const invalidKey = await app.inject({
      method: 'PUT',
      url: '/api/profile/fields/bad%20key',
      payload: { value: 'x' },
    });
    assert.equal(invalidKey.statusCode, 422);

    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/profile/fields/memory?baseRevision=2',
    });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual(body(removed), { ok: true });

    const missing = await app.inject({ method: 'GET', url: '/api/profile/fields/memory' });
    assert.equal(missing.statusCode, 404);
  });
});

test('memories are idempotent, paginated, patchable and archived', async () => {
  await withApp(async (app) => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { clientId: 'memory-1', type: 'identity', content: 'Likes TypeScript' },
    });
    assert.equal(created.statusCode, 201);
    const memory = body(created);
    assert.equal(memory.revision, 1);
    assert.equal(memory.status, 'active');

    const repeated = await app.inject({
      method: 'POST',
      url: '/api/memories',
      payload: { clientId: 'memory-1', type: 'identity', content: 'Ignored duplicate' },
    });
    assert.equal(repeated.statusCode, 201);
    assert.equal(body(repeated).id, memory.id);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/memories/${memory.id}`,
      payload: { baseRevision: 1, content: 'Likes TypeScript and Fastify' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(body(patched).content, 'Likes TypeScript and Fastify');
    assert.equal(body(patched).revision, 2);

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/api/memories/${memory.id}`,
      payload: { baseRevision: 1, content: 'stale' },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(body<{ error: { current: { revision: number } } }>(conflict).error.current.revision, 2);

    const active = await app.inject({ method: 'GET', url: '/api/memories?status=active' });
    assert.equal(body<{ items: Json[] }>(active).items.length, 1);

    const archived = await app.inject({
      method: 'DELETE',
      url: `/api/memories/${memory.id}?baseRevision=2`,
    });
    assert.equal(archived.statusCode, 200);
    assert.equal(body(archived).status, 'archived');
    assert.equal(body(archived).revision, 3);

    const activeAfter = await app.inject({ method: 'GET', url: '/api/memories?status=active' });
    assert.equal(body<{ items: Json[] }>(activeAfter).items.length, 0);
    const archivedAfter = await app.inject({ method: 'GET', url: '/api/memories?status=archived' });
    assert.equal(body<{ items: Json[] }>(archivedAfter).items.length, 1);

    const invalidId = await app.inject({
      method: 'PATCH',
      url: '/api/memories/not-a-uuid',
      payload: { baseRevision: 1, content: 'x' },
    });
    assert.equal(invalidId.statusCode, 422);

    const missingId = await app.inject({
      method: 'PATCH',
      url: `/api/memories/${crypto.randomUUID()}`,
      payload: { baseRevision: 1, content: 'x' },
    });
    assert.equal(missingId.statusCode, 404);
  });
});

test('conversation deletion tombstones paginate by client id', async () => {
  await withApp(async (app) => {
    const ids: string[] = [];
    for (const clientId of ['deleted-a', 'deleted-b']) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { clientId, title: clientId },
      });
      const conversation = body(created);
      ids.push(String(conversation.id));
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/conversations/${conversation.id}?baseRevision=1`,
      });
      assert.equal(deleted.statusCode, 200);
    }

    const first = await app.inject({ method: 'GET', url: '/api/workspace/conversation-deletions?limit=1' });
    assert.equal(first.statusCode, 200);
    const firstPage = body<{ items: string[]; nextCursor: string | null }>(first);
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);

    const second = await app.inject({
      method: 'GET',
      url: `/api/workspace/conversation-deletions?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    });
    const secondPage = body<{ items: string[]; nextCursor: string | null }>(second);
    assert.equal(secondPage.items.length, 1);
    assert.equal(new Set([...firstPage.items, ...secondPage.items]).size, 2);
    assert.ok(ids.length === 2);
  });
});
