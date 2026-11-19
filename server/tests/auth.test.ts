import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  assert.ok(raw, 'expected Set-Cookie header');
  return raw.split(';', 1)[0] ?? '';
}

test('AUTH_SECRET gates protected routes until unlocked via HttpOnly cookie', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-auth-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
    AUTH_SECRET: 'super-secret-value',
    AUTH_SESSION_TTL_SECONDS: '3600',
  });
  const { app } = await buildApp({ settings });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/health/ready' })).statusCode, 200);
    const status = await app.inject({ method: 'GET', url: '/api/auth/status' });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json(), { required: true, unlocked: false });

    for (const url of ['/api/features', '/api/models', '/api/conversations', '/api/files', '/api/usage', '/api/tasks']) {
      const blocked = await app.inject({ method: 'GET', url });
      assert.equal(blocked.statusCode, 401, `${url} should require unlock`);
      assert.equal(blocked.json<{ error: { code: string } }>().error.code, 'auth_required');
    }

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/unlock',
      payload: { secret: 'wrong-secret' },
    });
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.json<{ error: { code: string } }>().error.code, 'invalid_secret');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/unlock',
      payload: { secret: 'super-secret-value' },
    });
    assert.equal(ok.statusCode, 200);
    const setCookie = String(ok.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.equal(/;\s*Secure/i.test(setCookie), false, 'plain HTTP test request must not set Secure');
    const cookie = extractCookie(ok.headers['set-cookie']);

    const httpsUnlock = await app.inject({
      method: 'POST',
      url: '/api/auth/unlock',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { secret: 'super-secret-value' },
    });
    assert.match(String(httpsUnlock.headers['set-cookie']), /;\s*Secure/i);

    const unlockedFeatures = await app.inject({
      method: 'GET',
      url: '/api/features',
      headers: { cookie },
    });
    assert.equal(unlockedFeatures.statusCode, 200);
    assert.equal(unlockedFeatures.headers['x-matrius-auth'], 'required');

    const unlockedStatus = await app.inject({
      method: 'GET',
      url: '/api/auth/status',
      headers: { cookie },
    });
    assert.deepEqual(unlockedStatus.json(), { required: true, unlocked: true });

    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/lock',
      headers: { cookie },
    });
    assert.equal(locked.statusCode, 200);
    assert.match(String(locked.headers['set-cookie']), /Max-Age=0/i);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unlock endpoint rate-limits repeated failed attempts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-auth-rl-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
    AUTH_SECRET: 'rate-limit-secret',
  });
  const { app } = await buildApp({ settings });
  try {
    for (let i = 0; i < 10; i += 1) {
      const attempt = await app.inject({
        method: 'POST',
        url: '/api/auth/unlock',
        payload: { secret: 'bad' },
      });
      assert.equal(attempt.statusCode, 401);
    }
    const throttled = await app.inject({
      method: 'POST',
      url: '/api/auth/unlock',
      payload: { secret: 'rate-limit-secret' },
    });
    assert.equal(throttled.statusCode, 429);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production static serving delivers dist shell and SPA fallback even while API is locked', async () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'matrius-dist-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'matrius-dist-data-'));
  mkdirSync(join(repoDir, 'dist', 'assets'), { recursive: true });
  writeFileSync(join(repoDir, 'dist', 'index.html'), '<!doctype html><html><body>Matrius Shell</body></html>', 'utf8');
  writeFileSync(join(repoDir, 'dist', 'sw.js'), '// sw', 'utf8');
  writeFileSync(join(repoDir, 'dist', 'assets', 'app-123.js'), 'console.log(1);', 'utf8');

  const baseSettings = loadSettings({
    APP_ENV: 'production',
    DATA_DIR: dataDir,
    LOG_LEVEL: 'silent',
    AUTH_SECRET: 'dist-secret',
  }, { envFile: false });
  const settings = { ...baseSettings, repoRoot: repoDir };
  const { app } = await buildApp({ settings });
  try {
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 200);
    assert.equal(root.headers['cache-control'], 'no-cache');
    assert.match(root.body, /Matrius Shell/);

    const spaRoute = await app.inject({ method: 'GET', url: '/c/some-chat-id' });
    assert.equal(spaRoute.statusCode, 200);
    assert.equal(spaRoute.headers['cache-control'], 'no-cache');
    assert.match(spaRoute.body, /Matrius Shell/);

    const sw = await app.inject({ method: 'GET', url: '/sw.js' });
    assert.equal(sw.statusCode, 200);
    assert.equal(sw.headers['cache-control'], 'no-cache');

    const asset = await app.inject({ method: 'GET', url: '/assets/app-123.js' });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

    const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    assert.equal(missingAsset.statusCode, 404);

    const apiBlocked = await app.inject({ method: 'GET', url: '/api/models' });
    assert.equal(apiBlocked.statusCode, 401);
  } finally {
    await app.close();
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
