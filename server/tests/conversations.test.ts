import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { toDbTimestamp, toDbUuid } from '../db/codecs';
import type { AppDatabase } from '../db/client';

type Json = Record<string, unknown>;
type Ctx = { app: Awaited<ReturnType<typeof buildApp>>['app']; db: AppDatabase };

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-conversations-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
  });
  const { app, deps } = await buildApp({ settings });
  try {
    await fn({ app, db: deps.db });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function body<T = Json>(response: { json: () => unknown }): T {
  return response.json() as T;
}

async function createConversation(ctx: Ctx, payload: Json = {}): Promise<Json> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { title: 'Conversation', ...payload },
  });
  assert.equal(response.statusCode, 201);
  return body(response);
}

test('conversation create is idempotent by client id and lists with the stable shape', async () => {
  await withApp(async (ctx) => {
    const conversation = await createConversation(ctx, { clientId: 'client-conversation-1' });
    assert.match(String(conversation.id), /^[0-9a-f-]{36}$/u);
    assert.equal(conversation.revision, 1);
    assert.equal(conversation.clientId, 'client-conversation-1');
    assert.equal(conversation.contextSummary, null);
    assert.deepEqual(conversation.readState, {
      completed: { state: 'absent' },
      error: { state: 'absent' },
    });
    assert.ok(typeof conversation.createdAt === 'number');
    assert.ok(typeof conversation.updatedAt === 'number');

    const repeated = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { clientId: 'client-conversation-1', title: 'Ignored duplicate' },
    });
    assert.equal(repeated.statusCode, 201);
    assert.equal(body(repeated).id, conversation.id);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/conversations' });
    assert.equal(list.statusCode, 200);
    const listed = body<{ items: Json[]; nextCursor: string | null }>(list);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, conversation.id);
    assert.equal(listed.nextCursor, null);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(body(detail).messages, []);
    assert.equal(body(detail).nextCursor, null);
  });
});

test('conversation patches use revisions and return the current row on conflict', async () => {
  await withApp(async (ctx) => {
    const conversation = await createConversation(ctx);
    const id = String(conversation.id);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      payload: { baseRevision: 1, title: 'Renamed', pinned: true },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(body(patched).title, 'Renamed');
    assert.equal(body(patched).pinned, true);
    assert.equal(body(patched).revision, 2);

    const conflict = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      payload: { baseRevision: 1, title: 'Stale' },
    });
    assert.equal(conflict.statusCode, 409);
    const error = body<{ error: { code: string; current: Json } }>(conflict);
    assert.equal(error.error.code, 'conflict');
    assert.equal(error.error.current.revision, 2);

    const read = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/conversations/${id}`,
      payload: {
        baseRevision: 2,
        readState: { completed: { state: 'read' }, error: { state: 'unread' } },
      },
    });
    assert.equal(read.statusCode, 200);
    const readState = body<{ readState: { completed: Json; error: Json } }>(read).readState;
    assert.equal(readState.completed.state, 'read');
    assert.ok(typeof readState.completed.readAt === 'number');
    assert.deepEqual(readState.error, { state: 'unread' });
  });
});

test('messages keep positions, read state, pagination and activity payloads', async () => {
  await withApp(async (ctx) => {
    const conversation = await createConversation(ctx);
    const id = String(conversation.id);

    const user = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      payload: { role: 'user', content: 'Question', clientId: 'message-user-1' },
    });
    assert.equal(user.statusCode, 201);
    assert.equal(body(user).position, 1);
    assert.equal(body(user).status, 'complete');

    const search = {
      id: 'tool-1',
      kind: 'search',
      status: 'complete',
      query: 'matrius',
      results: [{ title: 'Matrius', url: 'https://example.com', domain: 'example.com', rank: 1 }],
      snippet: 'transient snippet',
      engine: 'duckduckgo',
    };
    const assistant = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      payload: {
        role: 'assistant',
        content: 'Answer',
        clientId: 'message-assistant-1',
        activities: [search],
        process: [
          { id: 'thinking-1', kind: 'thinking', content: 'reasoning', status: 'complete' },
          search,
        ],
      },
    });
    assert.equal(assistant.statusCode, 201);
    assert.equal(body(assistant).position, 2);
    const activities = body<{ activities: Json[] }>(assistant).activities;
    assert.deepEqual(activities, [{
      id: 'tool-1',
      kind: 'search',
      status: 'complete',
      query: 'matrius',
      results: [{ title: 'Matrius', url: 'https://example.com', domain: 'example.com', rank: 1 }],
    }]);
    assert.equal(JSON.stringify(activities).includes('snippet'), false);

    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${id}?messageLimit=1`,
    });
    assert.equal(detail.statusCode, 200);
    const firstPage = body<{
      messages: Json[];
      nextCursor: string | null;
      conversation: { readState: { completed: { state: string } } };
    }>(detail);
    assert.equal(firstPage.messages.length, 1);
    assert.equal(firstPage.messages[0].content, 'Answer');
    assert.equal(firstPage.conversation.readState.completed.state, 'unread');
    assert.ok(firstPage.nextCursor);

    const older = await ctx.app.inject({
      method: 'GET',
      url: `/api/conversations/${id}?messageLimit=1&before=${firstPage.nextCursor}`,
    });
    assert.equal(older.statusCode, 200);
    const secondPage = body<{ messages: Json[]; nextCursor: string | null }>(older);
    assert.equal(secondPage.messages.length, 1);
    assert.equal(secondPage.messages[0].content, 'Question');
    assert.equal(secondPage.nextCursor, null);
  });
});

test('message patches and deletes enforce revisions and user status rules', async () => {
  await withApp(async (ctx) => {
    const conversation = await createConversation(ctx);
    const id = String(conversation.id);
    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      payload: { role: 'user', content: 'Original' },
    });
    const messageId = String(body(created).id);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/messages/${messageId}`,
      payload: { baseRevision: 1, content: 'Edited', feedback: 'good' },
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(body(patched).content, 'Edited');
    assert.equal(body(patched).feedback, 'good');
    assert.equal(body(patched).revision, 2);

    const invalidStatus = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/messages/${messageId}`,
      payload: { baseRevision: 2, status: 'stopped' },
    });
    assert.equal(invalidStatus.statusCode, 422);

    const stale = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/messages/${messageId}?baseRevision=1`,
    });
    assert.equal(stale.statusCode, 409);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/messages/${messageId}?baseRevision=2`,
    });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(body(deleted), { ok: true });

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    assert.deepEqual(body(detail).messages, []);
  });
});

test('deleting a conversation records tombstones and blocks recreation', async () => {
  await withApp(async (ctx) => {
    const conversation = await createConversation(ctx, { clientId: 'deleted-conversation' });
    const id = String(conversation.id);

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/conversations/${id}?baseRevision=1`,
    });
    assert.equal(deleted.statusCode, 200);
    assert.deepEqual(body(deleted), { ok: true });

    const missing = await ctx.app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    assert.equal(missing.statusCode, 404);

    const recreateByClient = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { clientId: 'deleted-conversation' },
    });
    assert.equal(recreateByClient.statusCode, 409);

    const recreateById = await ctx.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { id },
    });
    assert.equal(recreateById.statusCode, 409);
  });
});

test('conversation cursor pagination never duplicates rows', async () => {
  await withApp(async (ctx) => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const conversation = await createConversation(ctx, { title: `Conversation ${index}` });
      ids.push(String(conversation.id));
    }

    // Force timestamps that differ only below the millisecond. The cursor must keep
    // all six fractional digits or the next page will skip rows.
    for (let index = 0; index < ids.length; index += 1) {
      ctx.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(
        `2026-11-13 10:00:00.12300${index + 1}`,
        toDbUuid(ids[index]),
      );
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const url: string = `/api/conversations?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await ctx.app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200);
      const payload = body<{ items: Json[]; nextCursor: string | null }>(response);
      seen.push(...payload.items.map((item) => String(item.id)));
      cursor = payload.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(new Set(seen).size, 3);
    assert.equal(seen.length, 3);
    assert.deepEqual(new Set(seen), new Set(ids));

    const invalid = await ctx.app.inject({
      method: 'GET',
      url: '/api/conversations?limit=1&cursor=not-a-cursor',
    });
    assert.equal(invalid.statusCode, 422);
  });
});

test('message attachments bind to one conversation and keep response order', async () => {
  await withApp(async (ctx) => {
    const fileId = randomUUID();
    const now = toDbTimestamp();
    ctx.db.prepare(
      `INSERT INTO files
       (id, instance_id, filename, object_key, content_type, size, sha256, status, revision, created_at, updated_at)
       VALUES (?, 1, ?, ?, 'text/plain', 3, ?, 'ready', 1, ?, ?)`,
    ).run(
      toDbUuid(fileId),
      'note.txt',
      `${toDbUuid(fileId)}/note.txt`,
      'a'.repeat(64),
      now,
      now,
    );

    const conversation = await createConversation(ctx);
    const id = String(conversation.id);
    const message = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${id}/messages`,
      payload: { role: 'user', content: 'Look', fileIds: [fileId] },
    });
    assert.equal(message.statusCode, 201);
    assert.deepEqual(body(message).fileIds, [fileId]);
    assert.deepEqual(body(message).files, [{
      id: fileId,
      filename: 'note.txt',
      contentType: 'text/plain',
      size: 3,
      revision: 1,
    }]);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/conversations/${id}` });
    const detailBody = body<{ messages: Array<{ files: Array<{ id: string }> }> }>(detail);
    assert.equal(detailBody.messages[0].files[0].id, fileId);

    const other = await createConversation(ctx, { title: 'Other' });
    const conflict = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${other.id}/messages`,
      payload: { role: 'user', content: 'Steal', fileIds: [fileId] },
    });
    assert.equal(conflict.statusCode, 422);
  });
});
