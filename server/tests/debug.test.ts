import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

async function withApp(
  env: Record<string, string>,
  fn: (app: Awaited<ReturnType<typeof buildApp>>['app']) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-debug-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
    ...env,
  });
  const { app } = await buildApp({ settings });
  try {
    await fn(app);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the debug page exposes API and health sections with local Swagger assets', async () => {
  await withApp({}, async (app) => {
    const page = await app.inject({ method: 'GET', url: '/debug' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] ?? '', /^text\/html/u);
    assert.match(page.body, /接口查询/u);
    assert.match(page.body, /运行状态/u);
    assert.match(page.body, /swagger-ui-bundle\.js/u);

    const spec = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    assert.equal(spec.statusCode, 200);
    const document = spec.json() as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    assert.equal(document.openapi, '3.0.3');
    assert.ok(document.paths['/api/conversations']);
    assert.ok(document.paths['/api/agent/runs']);
    assert.ok(document.components.schemas.Conversation);
    assert.ok(document.components.schemas.AgentRunRequest);

    const asset = await app.inject({ method: 'GET', url: '/debug-assets/swagger-ui.css' });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers['content-type'] ?? '', /^text\/css/u);
  });
});

test('the debug page can be disabled explicitly', async () => {
  await withApp({ ENABLE_DEBUG_PAGE: 'false' }, async (app) => {
    assert.equal((await app.inject({ method: 'GET', url: '/debug' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/openapi.json' })).statusCode, 404);
  });
});
