import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

test('desktop chat settings are applied immediately and survive restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-chat-settings-'));
  const settings = loadSettings({ APP_ENV: 'test', MATRIUS_DESKTOP_DEV: 'true', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  let built = await buildApp({ settings });
  t.after(async () => {
    await built.app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = '/api/desktop/chat-settings';
  const { app } = built;
  const initial = (await app.inject(path)).json();
  assert.deepEqual(initial, { storageLimitBytes: 134217728, webtoolProxyUrl: '', revision: 0 });
  assert.ok((await app.inject('/api/features')).json().features.some(({ id }: { id: string }) => id === 'desktop-chat-settings'));
  const payload = { storageLimitBytes: 1024, webtoolProxyUrl: 'http://127.0.0.1:7890', baseRevision: 0 };
  const update = (body: typeof payload) => app.inject({ method: 'PUT', url: path, payload: body });
  assert.equal((await update({ ...payload, webtoolProxyUrl: 'file:///test' })).statusCode, 422);
  const response = await update(payload);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { storageLimitBytes: 1024, webtoolProxyUrl: payload.webtoolProxyUrl, revision: 1 });
  assert.equal(built.deps.settings.STORAGE_LIMIT_BYTES, 1024);
  assert.equal(built.deps.settings.WEBTOOL_PROXY_URL, payload.webtoolProxyUrl);
  assert.equal((await update(payload)).statusCode, 409);
  await app.close();
  built = await buildApp({ settings });
  assert.deepEqual((await built.app.inject(path)).json(), response.json());
  assert.equal(built.deps.settings.WEBTOOL_PROXY_URL, payload.webtoolProxyUrl);
  assert.equal((await built.app.inject({ method: 'PUT', url: path, payload: {
    ...payload, webtoolProxyUrl: '', baseRevision: 1,
  } })).statusCode, 200);
  assert.equal(built.deps.settings.WEBTOOL_PROXY_URL, '');
});
