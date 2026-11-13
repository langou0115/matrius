import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

type Json = Record<string, unknown>;
type Upload = { status: number; body: Json };

async function withServer(fn: (baseUrl: string, app: Awaited<ReturnType<typeof buildApp>>['app']) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-files-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
  });
  const { app } = await buildApp({ settings });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl, app);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function readJson<T = Json>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function upload(
  baseUrl: string,
  file: { filename: string; content: string | Uint8Array; type: string },
  fields: Record<string, string> = {},
): Promise<Upload> {
  const form = new FormData();
  const bytes = typeof file.content === 'string'
    ? new TextEncoder().encode(file.content)
    : file.content;
  form.append('file', new Blob([bytes], { type: file.type }), file.filename);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const response = await fetch(`${baseUrl}/api/files`, { method: 'POST', body: form });
  return { status: response.status, body: await readJson(response) };
}

test('files upload, list, download, rename and delete', async () => {
  await withServer(async (baseUrl) => {
    const uploaded = await upload(baseUrl, {
      filename: 'note.txt',
      content: 'hello',
      type: 'text/plain',
    }, { clientId: 'file-client-1' });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.filename, 'note.txt');
    assert.equal(uploaded.body.size, 5);
    assert.equal(uploaded.body.contentType, 'text/plain');
    assert.equal(String(uploaded.body.sha256).length, 64);
    assert.equal(uploaded.body.conversationId, null);

    const repeated = await upload(baseUrl, {
      filename: 'note.txt',
      content: 'ignored',
      type: 'text/plain',
    }, { clientId: 'file-client-1' });
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.id, uploaded.body.id);

    const list = await fetch(`${baseUrl}/api/files?kind=text&sort=name&order=asc`);
    const listed = await readJson<{ items: Json[]; nextCursor: string | null }>(list);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, uploaded.body.id);
    assert.equal(listed.nextCursor, null);

    const metadata = await fetch(`${baseUrl}/api/files/${uploaded.body.id}`);
    assert.equal(metadata.status, 200);
    assert.equal((await readJson(metadata)).filename, 'note.txt');

    const content = await fetch(`${baseUrl}/api/files/${uploaded.body.id}/content`);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
    assert.match(content.headers.get('content-disposition') ?? '', /^attachment;/u);
    assert.equal(await content.text(), 'hello');

    const renamed = await fetch(`${baseUrl}/api/files/${uploaded.body.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'renamed.txt' }),
    });
    assert.equal(renamed.status, 200);
    const renamedBody = await readJson(renamed);
    assert.equal(renamedBody.filename, 'renamed.txt');
    assert.equal(renamedBody.revision, 2);
    const renamedContent = await fetch(`${baseUrl}/api/files/${uploaded.body.id}/content`);
    assert.equal(await renamedContent.text(), 'hello');

    const badExtension = await fetch(`${baseUrl}/api/files/${uploaded.body.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'renamed.md' }),
    });
    assert.equal(badExtension.status, 422);

    const usage = await readJson(await fetch(`${baseUrl}/api/files/usage`));
    assert.equal(usage.used, 5);
    assert.equal((usage.files as Json).count, 1);
    assert.equal((usage.images as Json).count, 0);

    const removed = await fetch(`${baseUrl}/api/files/${uploaded.body.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await readJson(removed), { ok: true });
    assert.equal((await fetch(`${baseUrl}/api/files/${uploaded.body.id}`)).status, 404);
    assert.equal((await readJson(await fetch(`${baseUrl}/api/files/usage`))).used, 0);
  });
});

test('images are classified separately and invalid files are rejected', async () => {
  await withServer(async (baseUrl) => {
    const image = await upload(baseUrl, {
      filename: 'picture.png',
      content: 'not-a-real-png',
      type: 'image/png',
    });
    assert.equal(image.status, 201);
    const usage = await readJson(await fetch(`${baseUrl}/api/files/usage`));
    assert.equal((usage.images as Json).count, 1);
    assert.equal((usage.images as Json).bytes, 14);
    assert.equal((usage.files as Json).count, 0);

    const images = await readJson<{ items: Json[] }>(await fetch(`${baseUrl}/api/files?kind=image`));
    assert.equal(images.items.length, 1);

    const unsupported = await upload(baseUrl, {
      filename: 'archive.zip',
      content: 'PK',
      type: 'application/zip',
    });
    assert.equal(unsupported.status, 415);

    const empty = await upload(baseUrl, {
      filename: 'empty.txt',
      content: '',
      type: 'text/plain',
    });
    assert.equal(empty.status, 422);
  });
});

test('files attach to a conversation and bulk delete removes only owned rows', async () => {
  await withServer(async (baseUrl) => {
    const conversationResponse = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'file-conversation', title: 'Files' }),
    });
    const conversation = await readJson(conversationResponse);

    const first = await upload(baseUrl, {
      filename: 'first.txt',
      content: 'first',
      type: 'text/plain',
    }, { conversationId: 'file-conversation' });
    assert.equal(first.status, 201);
    assert.equal(first.body.conversationId, conversation.id);

    const second = await upload(baseUrl, {
      filename: 'second.txt',
      content: 'second',
      type: 'text/plain',
    });
    assert.equal(second.status, 201);

    const scoped = await readJson<{ items: Json[] }>(await fetch(`${baseUrl}/api/files?conversationId=file-conversation`));
    assert.equal(scoped.items.length, 1);
    assert.equal(scoped.items[0].id, first.body.id);

    const bulk = await fetch(`${baseUrl}/api/files/bulk-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [first.body.id, second.body.id] }),
    });
    assert.equal(bulk.status, 200);
    assert.deepEqual(await readJson(bulk), { deleted: 2 });
    assert.equal((await readJson<{ items: Json[] }>(await fetch(`${baseUrl}/api/files`))).items.length, 0);
  });
});

test('file lists use keyset pagination', async () => {
  await withServer(async (baseUrl) => {
    const ids: string[] = [];
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const uploaded = await upload(baseUrl, { filename: name, content: name, type: 'text/plain' });
      ids.push(String(uploaded.body.id));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const url: string = `${baseUrl}/api/files?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const response = await fetch(url);
      const payload = await readJson(response) as { items: Json[]; nextCursor: string | null };
      seen.push(...payload.items.map((item) => String(item.id)));
      cursor = payload.nextCursor;
      if (!cursor) break;
    }
    assert.equal(seen.length, 3);
    assert.deepEqual(new Set(seen), new Set(ids));
  });
});
