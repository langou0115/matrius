import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadSettings } from '../config';

// `APP_ENV=production` skips .env.local, so these assertions only cover the
// built-in defaults and the values passed in explicitly.
test('data defaults to ~/.matrius with a 128 MiB storage budget', () => {
  const settings = loadSettings({ APP_ENV: 'production', LOG_LEVEL: 'silent' });
  assert.equal(settings.dataDir, join(homedir(), '.matrius'));
  assert.equal(settings.databasePath, join(homedir(), '.matrius', 'matrius.db'));
  assert.equal(settings.STORAGE_LIMIT_BYTES, 128 * 1024 * 1024);
});

test('DATA_DIR and STORAGE_LIMIT_BYTES can be overridden', () => {
  const settings = loadSettings({
    APP_ENV: 'production',
    LOG_LEVEL: 'silent',
    DATA_DIR: '~/matrius-test-data',
    STORAGE_LIMIT_BYTES: '1024',
  });
  assert.equal(settings.dataDir, join(homedir(), 'matrius-test-data'));
  assert.equal(settings.databasePath, join(homedir(), 'matrius-test-data', 'matrius.db'));
  assert.equal(settings.STORAGE_LIMIT_BYTES, 1024);
});
