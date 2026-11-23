import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadSettings } from '../config';

test('data defaults to ~/.matrius with a 128 MiB storage budget', () => {
  const settings = loadSettings({ APP_ENV: 'production', LOG_LEVEL: 'silent' }, { envFile: false });
  assert.equal(settings.dataDir, join(homedir(), '.matrius'));
  assert.equal(settings.databasePath, join(homedir(), '.matrius', 'matrius.db'));
  assert.equal(settings.STORAGE_LIMIT_BYTES, 128 * 1024 * 1024);
  assert.equal(settings.authEnabled, false);
});

test('DATA_DIR and STORAGE_LIMIT_BYTES can be overridden', () => {
  const settings = loadSettings({
    APP_ENV: 'production',
    LOG_LEVEL: 'silent',
    DATA_DIR: '~/matrius-test-data',
    STORAGE_LIMIT_BYTES: '1024',
  }, { envFile: false });
  assert.equal(settings.dataDir, join(homedir(), 'matrius-test-data'));
  assert.equal(settings.databasePath, join(homedir(), 'matrius-test-data', 'matrius.db'));
  assert.equal(settings.STORAGE_LIMIT_BYTES, 1024);
});

test('production reads .env.local as defaults while process env takes precedence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-config-'));
  const envPath = join(directory, '.env.local');
  writeFileSync(envPath, 'AUTH_SECRET=file-secret\nSTORAGE_LIMIT_BYTES=2048\n', 'utf8');
  try {
    const fromFile = loadSettings({ APP_ENV: 'production', LOG_LEVEL: 'silent' }, { envFile: envPath });
    assert.equal(fromFile.AUTH_SECRET, 'file-secret');
    assert.equal(fromFile.authEnabled, true);
    assert.equal(fromFile.STORAGE_LIMIT_BYTES, 2048);

    const overridden = loadSettings({
      APP_ENV: 'production',
      LOG_LEVEL: 'silent',
      AUTH_SECRET: 'env-secret',
    }, { envFile: envPath });
    assert.equal(overridden.AUTH_SECRET, 'env-secret');
    assert.equal(overridden.STORAGE_LIMIT_BYTES, 2048);

    const desktop = loadSettings(
      { APP_ENV: 'development', MATRIUS_DESKTOP_DEV: 'true', API_PORT: '9001' },
      { envFile: envPath },
    );
    assert.equal(desktop.authEnabled, false);
    assert.equal(desktop.STORAGE_LIMIT_BYTES, 134217728);
    assert.equal(desktop.API_PORT, 9001);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('API_PORT in .env.local configures server port and defaults to 8000', () => {
  const defaults = loadSettings({ APP_ENV: 'production', LOG_LEVEL: 'silent' }, { envFile: false });
  assert.equal(defaults.API_PORT, 8000);

  const directory = mkdtempSync(join(tmpdir(), 'matrius-config-port-'));
  const envPath = join(directory, '.env.local');
  writeFileSync(envPath, 'WEB_PORT=8088\nAPI_PORT=8008\n', 'utf8');
  try {
    const fromEnvFile = loadSettings({ APP_ENV: 'production', LOG_LEVEL: 'silent' }, { envFile: envPath });
    assert.equal(fromEnvFile.API_PORT, 8008);

    const fromProcessEnv = loadSettings(
      { APP_ENV: 'production', LOG_LEVEL: 'silent', API_PORT: '9001' },
      { envFile: envPath },
    );
    assert.equal(fromProcessEnv.API_PORT, 9001);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
