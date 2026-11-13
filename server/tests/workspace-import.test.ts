import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { fromDbJson } from '../db/codecs';
import { findConversationByIdOrClient } from '../db/repositories/conversations';
import { insertFileRow } from '../db/repositories/files';

async function withApp(fn: (ctx: Awaited<ReturnType<typeof buildApp>>) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-import-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const ctx = await buildApp({ settings });
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedFile(ctx: Awaited<ReturnType<typeof buildApp>>): string {
  const id = randomUUID();
  ctx.deps.storage.put(`${id}/owned.txt`, new TextEncoder().encode('owned'));
  insertFileRow(ctx.deps.db, {
    id,
    instanceId: 1,
    clientId: null,
    conversationId: null,
    filename: 'owned.txt',
    objectKey: `${id}/owned.txt`,
    contentType: 'text/plain',
    size: 5,
    sha256: 'a'.repeat(64),
  });
  return id;
}

test('workspace import creates conversations, messages, settings and file ownership', async () => {
  await withApp(async (ctx) => {
    const ownedFileId = seedFile(ctx);
    const now = Date.now();
    const payload = {
      schemaVersion: 1,
      chat: {
        conversations: [{
          id: 'local-import-1',
          title: 'Imported chat',
          pinned: true,
          updatedAt: now,
          modelId: 'deepseek-chat',
          titleSource: 'manual',
          messages: [
            {
              id: 'local-message-1',
              role: 'user',
              content: 'hello',
              fileIds: [ownedFileId, randomUUID()],
            },
            {
              id: 'local-message-2',
              role: 'assistant',
              content: 'hi',
              reasoning: 'because',
              status: 'complete',
            },
          ],
        }],
        deletedConversationIds: [],
      },
      appearance: { themeId: 'dark', mode: 'dark' },
      personalization: {
        customInstructions: 'instructions',
        aboutName: 'Name',
        occupation: 'Work',
        aboutMore: 'More',
      },
    };

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspace/import',
      payload,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      imported: { conversations: 1, messages: 2 },
      updated: 0,
      skipped: 0,
      failed: [],
    });

    const conversation = findConversationByIdOrClient(ctx.deps.db, 1, null, 'local-import-1');
    assert.ok(conversation);
    assert.equal(conversation.title, 'Imported chat');
    assert.equal(conversation.pinned, 1);
    const messages = ctx.deps.db.prepare(
      'SELECT role, content, file_ids, reasoning FROM messages WHERE conversation_id = ? ORDER BY position',
    ).all(conversation.id) as Array<{
      role: string;
      content: string;
      file_ids: string;
      reasoning: string | null;
    }>;
    assert.equal(messages.length, 2);
    assert.deepEqual(fromDbJson<string[]>(messages[0].file_ids), [ownedFileId]);
    assert.equal(messages[1].reasoning, 'because');

    const preferences = await ctx.app.inject({ method: 'GET', url: '/api/preferences' });
    assert.equal(preferences.json().themeId, 'dark');
    const profile = await ctx.app.inject({ method: 'GET', url: '/api/profile' });
    assert.equal(profile.json().customInstructions, 'instructions');
  });
});

test('workspace import is idempotent, merges new messages and honours tombstones', async () => {
  await withApp(async (ctx) => {
    const now = Date.now();
    const payload = {
      schemaVersion: 1,
      chat: {
        conversations: [{
          id: 'local-import-2',
          title: 'First title',
          updatedAt: now,
          messages: [{ id: 'm1', role: 'user', content: 'one' }],
        }],
        deletedConversationIds: [],
      },
    };
    const first = await ctx.app.inject({ method: 'POST', url: '/api/workspace/import', payload });
    assert.equal(first.statusCode, 200);
    const repeat = await ctx.app.inject({ method: 'POST', url: '/api/workspace/import', payload });
    assert.deepEqual(repeat.json(), {
      imported: { conversations: 0, messages: 0 },
      updated: 0,
      skipped: 1,
      failed: [],
    });

    const merged = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspace/import',
      payload: {
        schemaVersion: 1,
        chat: {
          conversations: [{
            id: 'local-import-2',
            title: 'Updated title',
            updatedAt: now + 1_000,
            messages: [
              { id: 'm1', role: 'user', content: 'one' },
              { id: 'm2', role: 'assistant', content: 'two' },
            ],
          }],
          deletedConversationIds: [],
        },
      },
    });
    assert.equal(merged.statusCode, 200);
    assert.equal(merged.json().updated, 1);
    assert.equal(merged.json().imported.messages, 1);

    const deleted = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspace/import',
      payload: {
        schemaVersion: 1,
        chat: { conversations: [], deletedConversationIds: ['local-import-2'] },
      },
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(findConversationByIdOrClient(ctx.deps.db, 1, null, 'local-import-2'), undefined);

    const afterDelete = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspace/import',
      payload: {
        schemaVersion: 1,
        chat: {
          conversations: [{
            id: 'local-import-2',
            title: 'Recreated',
            messages: [{ id: 'm3', role: 'user', content: 'three' }],
          }],
          deletedConversationIds: [],
        },
      },
    });
    assert.equal(afterDelete.statusCode, 200);
    assert.equal(afterDelete.json().skipped, 1);
    assert.equal(findConversationByIdOrClient(ctx.deps.db, 1, null, 'local-import-2'), undefined);
  });
});

test('workspace import rejects an unsupported schema version', async () => {
  await withApp(async (ctx) => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/workspace/import',
      payload: { schemaVersion: 2 },
    });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'invalid');
  });
});
