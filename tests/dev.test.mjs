import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertAdminPassword, availablePort, devAdminCredentials, devApiArgs, devDataDir, devEnvironment, devPorts, resetDatabase,
  resetTargets, sqliteUrl, supervise,
} from '../scripts/dev.mjs';
const { handleDevApi } = createRequire(import.meta.url)('../scripts/dev-api-proxy.cjs');

test('development ports validate overrides', () => {
  assert.deepEqual(devPorts({}), [8081, 8000]);
  assert.deepEqual(devPorts({ DEV_WEB_PORT: '8082', DEV_API_PORT: '8001' }), [8082, 8001]);
  for (const value of ['0', '-1', '65536', 'abc', '80;bad']) assert.throws(() => devPorts({ DEV_WEB_PORT: value }));
  assert.throws(() => devPorts({ DEV_WEB_PORT: '8000' }), /differ/);
});

test('SQLite URLs work on POSIX and Windows without a shell', () => {
  assert.equal(sqliteUrl('/repo/server/.data/dev.db'), 'sqlite+aiosqlite:////repo/server/.data/dev.db');
  assert.equal(sqliteUrl('C:\\repo\\server\\.data\\dev.db'), 'sqlite+aiosqlite:///C:/repo/server/.data/dev.db');
  assert.equal(sqliteUrl('D:/matrius/server/.data/dev.db'), 'sqlite+aiosqlite:///D:/matrius/server/.data/dev.db');
});

test('development environment is local-only and never inherits production data locations', () => {
  const dataDir = '/repo/server/.data';
  const env = devEnvironment({
    env: {
      INITIAL_ADMIN_USERNAME: 'prod-admin', INITIAL_ADMIN_PASSWORD: 'production',
      DATABASE_URL: 'postgresql+asyncpg://prod', DATA_DIR: '/data',
    },
    dataDir,
    webPort: 8081,
  });
  assert.equal(env.APP_ENV, 'development');
  assert.equal(env.APP_URL, 'http://localhost:8081');
  assert.equal(env.DATABASE_URL, 'sqlite+aiosqlite:////repo/server/.data/dev.db');
  assert.equal(env.DATA_DIR, dataDir);
  assert.equal(env.INITIAL_ADMIN_USERNAME, 'prod-admin');
  assert.equal(env.INITIAL_ADMIN_PASSWORD, 'production');
  assert.equal(devDataDir('/repo'), join('/repo', 'server', '.data'));
});

test('development API watches application code and isolates Windows console signals', () => {
  const windows = devApiArgs(8000, 'win32');
  assert.deepEqual(windows.slice(0, 4), ['run', '--no-sync', 'python', 'scripts/dev-api.py']);
  for (const platform of ['win32', 'linux', 'darwin']) {
    const args = devApiArgs(8000, platform);
    assert.equal(args[args.indexOf('--reload-dir') + 1], 'app');
    assert.equal(args[args.indexOf('--port') + 1], '8000');
    if (platform !== 'win32') assert.equal(args[2], 'uvicorn');
  }
});

test('development admin credentials use INITIAL_ADMIN_* and local defaults', () => {
  assert.deepEqual(devAdminCredentials({}), { username: 'admin', password: 'dev-password' });
  assert.deepEqual(
    devAdminCredentials({ INITIAL_ADMIN_USERNAME: 'alice', INITIAL_ADMIN_PASSWORD: 'local-secret' }),
    { username: 'alice', password: 'local-secret' },
  );
  assert.deepEqual(
    devAdminCredentials({ DEV_ADMIN_USERNAME: 'ignored', DEV_ADMIN_PASSWORD: 'ignored' }),
    { username: 'admin', password: 'dev-password' },
  );
});

test('placeholder administrator passwords stop development', () => {
  assert.throws(() => assertAdminPassword({ INITIAL_ADMIN_PASSWORD: 'CHANGE-ME' }), /change-me/);
  assert.doesNotThrow(() => assertAdminPassword({ INITIAL_ADMIN_PASSWORD: 'real-password' }));
});

test('--reset-db only removes the development database and uploaded files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-dev-data-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'files'), { recursive: true });
  for (const name of ['dev.db', 'dev.db-wal', 'dev.db-shm', 'other.db', 'notes.txt']) {
    await writeFile(join(directory, name), name);
  }
  await writeFile(join(directory, 'files/upload.png'), 'image');
  for (const target of resetTargets(directory)) {
    assert(target.startsWith(resolve(directory)), `${target} must stay inside the data directory`);
  }
  await resetDatabase(directory);
  assert.equal((await readFile(join(directory, 'other.db'), 'utf8')), 'other.db');
  assert.equal((await readFile(join(directory, 'notes.txt'), 'utf8')), 'notes.txt');
  await assert.rejects(readFile(join(directory, 'dev.db')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'dev.db-wal')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(directory, 'files/upload.png')), { code: 'ENOENT' });
  assert((await stat(join(directory, 'files'))).isDirectory());
});

test('occupied ports fail rather than redirecting development to an unrelated process', async (t) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((accept) => server.close(accept)));
  await assert.rejects(availablePort(server.address().port), { code: 'EADDRINUSE' });
});

test('supervisor stops all children after one exits and cleanup can be awaited repeatedly', { timeout: 10000 }, async () => {
  const runner = supervise();
  try {
    const child = runner.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const failed = runner.start(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    runner.watch(failed, 'fixture');
    assert.equal(await runner.finished, 7);
    assert.match(runner.failure.message, /fixture exited \(7\)/);
    await Promise.all([runner.stop(), runner.stop()]);
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  } finally { await runner.stop(); }
});

test('supervisor reports missing executables and cleans up surviving children', { timeout: 10000 }, async () => {
  const runner = supervise();
  try {
    runner.start('matrius-missing-command-fixture', [], { stdio: 'ignore' });
    assert.equal(await runner.finished, 1);
  } finally { await runner.stop(); }
});

test('Windows backend survives repeated Uvicorn reloads and its entire tree stops', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async (t) => {
  const python = resolve('server/.venv/Scripts/python.exe');
  try { await stat(python); } catch { t.skip('Install backend development dependencies first.'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'matrius-reload-'));
  const fixture = join(directory, 'fixture_api.py');
  const source = 'from fastapi import FastAPI\napp = FastAPI()\n';
  await writeFile(fixture, source);
  const port = await availablePort();
  const runner = supervise();
  let output = '';
  try {
    const child = runner.start(python, [resolve('server/scripts/dev-api.py'),
      'fixture_api:app', '--host', '127.0.0.1', '--port', String(port), '--reload', '--reload-dir', directory],
    { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    runner.watch(child, 'fixture API');
    const waitForStart = async (count) => {
      const deadline = Date.now() + 5000;
      while ((output.match(/Application startup complete/g) ?? []).length < count) {
        assert.equal(runner.failure, undefined, output);
        assert.ok(Date.now() < deadline, `Reload ${count} did not complete:\n${output}`);
        await new Promise((accept) => setTimeout(accept, 50));
      }
    };
    await waitForStart(1);
    for (let count = 2; count <= 3; count++) {
      await writeFile(fixture, `${source}# reload ${count}\n`);
      await waitForStart(count);
    }
    assert.equal(child.exitCode, null, 'reloading must not terminate the launcher');
  } catch (error) {
    error.message += `\nBackend output:\n${output}`;
    throw error;
  } finally {
    await runner.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
  assert.equal(await availablePort(port), port, 'cleanup must release the worker socket');
});

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('same-origin API proxy preserves POST body, auth, query, status and streamed response', async (t) => {
  const upstream = createServer(async (req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/test?cursor=a%2Fb');
    assert.equal(req.headers.authorization, 'Bearer fixture');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 1, 255, 65]));
    res.writeHead(409, { 'Content-Type': 'application/json', 'X-Request-ID': 'fixture' });
    res.write('{"error":'); res.end('"conflict"}');
  });
  const target = await listen(upstream);
  const proxy = createServer((req, res) => { if (!handleDevApi(req, res, target)) { res.writeHead(404); res.end(); } });
  const origin = await listen(proxy);
  t.after(() => { upstream.closeAllConnections(); proxy.closeAllConnections(); upstream.close(); proxy.close(); });
  const result = await fetch(`${origin}/api/test?cursor=a%2Fb`, { method: 'POST',
    headers: { Authorization: 'Bearer fixture' }, body: Buffer.from([0, 1, 255, 65]) });
  assert.equal(result.status, 409); assert.equal(result.headers.get('x-request-id'), 'fixture');
  assert.deepEqual(await result.json(), { error: 'conflict' });
  assert.equal((await fetch(`${origin}/other`)).status, 404);
});

test('API failure returns a safe 502; malformed target cannot forward off-machine', async (t) => {
  const port = await availablePort();
  const proxy = createServer((req, res) => handleDevApi(req, res, `http://127.0.0.1:${port}`));
  const origin = await listen(proxy);
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const response = await fetch(`${origin}/api/auth/me`);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'unavailable');
  for (const target of ['invalid', 'http://example.com', 'http://127.0.0.1:8000/']) {
    let status;
    assert.equal(handleDevApi({ url: '/api/auth/me' }, { set statusCode(value) { status = value; }, end() {} }, target), true);
    assert.equal(status, 502);
  }
});
