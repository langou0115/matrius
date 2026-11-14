import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

function testSettings() {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-health-'));
  return {
    directory,
    settings: loadSettings({
      APP_ENV: 'test',
      DATA_DIR: directory,
      PORT: '8000',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'silent',
      WEBTOOL_PROXY_URL: '',
    }),
  };
}

test('health reports database and schema readiness', async () => {
  const { directory, settings } = testSettings();
  const { app, deps } = await buildApp({ settings });
  try {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { service: 'matrius', status: 'ok' });

    const ready = await app.inject({ method: 'GET', url: '/api/health/ready' });
    assert.equal(ready.statusCode, 200);
    const payload = ready.json() as {
      status: string;
      checks: Record<string, string>;
      webTools: { proxy: string; fetchTimeoutSeconds: number; fetchMaxAttempts: number };
      documents: { status: string };
    };
    assert.equal(payload.status, 'ok');
    assert.deepEqual(payload.checks, {
      database: 'ok',
      schema: 'ok',
      cache: 'ok',
      storage: 'ok',
    });
    assert.deepEqual(payload.webTools, { proxy: 'direct', fetchTimeoutSeconds: 3, fetchMaxAttempts: 2 });
    assert.equal(payload.documents.status, 'pending');

    // The readiness probe must notice a migration mismatch, not only a broken DB.
    deps.db.prepare('DELETE FROM alembic_version').run();
    deps.db.prepare('INSERT INTO alembic_version (version_num) VALUES (?)').run('9999_future');
    const degraded = await app.inject({ method: 'GET', url: '/api/health/ready' });
    assert.equal(degraded.statusCode, 503);
    assert.equal((degraded.json() as { checks: { schema: string } }).checks.schema, 'error');
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown API routes keep the stable error envelope', async () => {
  const { directory, settings } = testSettings();
  const { app } = await buildApp({ settings });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: { code: 'not_found', message: '资源不存在。' },
    });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
