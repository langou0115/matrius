import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { FEATURES, featureIds } from '../features/registry';

test('the features endpoint is public and uncached', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-features-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
  });
  const { app } = await buildApp({ settings });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/features' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { features: FEATURES });
    assert.deepEqual(featureIds(), ['files', 'usage']);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
