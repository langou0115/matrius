import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { apiEnvironment, availablePort, devPorts, infrastructure, openTunnel, sshArgs, supervise, verifyDatabaseTunnel } from '../scripts/dev.mjs';
import { shellQuote } from '../scripts/deploy.mjs';
const { handleDevApi } = createRequire(import.meta.url)('../scripts/dev-api-proxy.cjs');
const execute = promisify(execFile);

const containers = ['postgres', 'redis', 'rustfs', 'openserp'].map((name, index) => ({
  Name: `/matrius-${name}`, State: { Running: true },
  NetworkSettings: { Networks: { data: { IPAddress: `172.20.0.${index + 2}` } } },
  Config: { Env: ['POSTGRES_USER=test user', 'POSTGRES_DB=shared', 'POSTGRES_PASSWORD=p@ss:/=word',
    'REDIS_PASSWORD=r@:/=word', 'RUSTFS_ACCESS_KEY=access', 'RUSTFS_SECRET_KEY=secret'] },
}));

test('cloud discovery requires all four running services and valid tunnel addresses', () => {
  assert.equal(infrastructure(containers)[0].env.POSTGRES_PASSWORD, 'p@ss:/=word');
  assert.throws(() => infrastructure(containers.slice(1)), /not running/);
  assert.throws(() => infrastructure([{ ...containers[0], State: { Running: false } }, ...containers.slice(1)]), /not running/);
  assert.throws(() => infrastructure([{ ...containers[0], NetworkSettings: {} }, ...containers.slice(1)]), /IPv4/);
  assert.equal(infrastructure(containers)[0].port, 5432);
  const custom = [{ ...containers[0], Config: { ...containers[0].Config, Labels: { 'io.matrius.dev.port': '15432' } } }, ...containers.slice(1)];
  assert.equal(infrastructure(custom)[0].port, 15432);
  custom[0].Config.Labels['io.matrius.dev.port'] = '65536';
  assert.throws(() => infrastructure(custom), /Invalid port/);
});

test('remote discovery reads stopped API metadata and tolerates absent API or release file', async () => {
  const bash = process.platform === 'win32'
    ? resolve((await execute('git', ['--exec-path'], { encoding: 'utf8' })).stdout.trim(), '../../../bin/bash.exe') : 'bash';
  const script = (await readFile(new URL('../scripts/dev/discover.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  for (const exists of [false, true]) {
    const api = [{ Name: '/matrius-api', State: { Running: false }, Config: { Env: ['RUSTFS_BUCKET=shared'] } }];
    const mock = `docker() {
      case "$*" in
        'inspect matrius-api') printf '%s' ${shellQuote(exists ? JSON.stringify(api) : '[]')}; return ${exists ? 0 : 1} ;;
        cp*) ${exists ? "printf '%s' '[\"published\"]'" : 'return 1'} ;;
        inspect*) printf '%s' ${shellQuote(JSON.stringify(containers))} ;;
      esac
    }
    tar() { cat; }
    `;
    const { stdout } = await execute(bash, ['-c', mock + script], { encoding: 'utf8' });
    const result = JSON.parse(stdout);
    assert.equal(result.infrastructure.length, 4);
    assert.deepEqual(result.api, exists ? api : []);
    assert.deepEqual(result.releases, exists ? ['published'] : []);
  }
});

test('backend environment encodes credentials, uses tunnels and keeps only runtime settings', () => {
  const env = apiEnvironment(infrastructure(containers), [10001, 10002, 10003, 10004],
    { RUSTFS_BUCKET: 'existing-bucket', PREVIEW_USERNAME: 'tester', INITIAL_ADMIN_PASSWORD: 'do-not-copy', DATABASE_URL: 'cloud' });
  assert.equal(env.DATABASE_URL, 'postgresql+asyncpg://test%20user:p%40ss%3A%2F%3Dword@127.0.0.1:10001/shared');
  assert.equal(env.REDIS_URL, 'redis://:r%40%3A%2F%3Dword@127.0.0.1:10002/0');
  assert.equal(env.OPENSERP_URL, 'http://127.0.0.1:10004');
  assert.equal(env.RUSTFS_BUCKET, 'existing-bucket');
  assert.equal(env.PREVIEW_USERNAME, 'tester');
  assert(!Object.hasOwn(env, 'INITIAL_ADMIN_PASSWORD'));
  const missing = infrastructure(containers); missing[1].env.REDIS_PASSWORD = '';
  assert.throws(() => apiEnvironment(missing, [1, 2, 3, 4]), /credentials/);
});

test('ports and SSH options validate overrides without invoking a local shell', () => {
  assert.deepEqual(devPorts({}), [8081, 8000]);
  assert.deepEqual(devPorts({ DEV_WEB_PORT: '8082', DEV_API_PORT: '8001' }), [8082, 8001]);
  for (const value of ['0', '-1', '65536', 'abc', '80;bad']) assert.throws(() => devPorts({ DEV_WEB_PORT: value }));
  assert.throws(() => devPorts({ DEV_WEB_PORT: '8000' }), /differ/);
  const args = sshArgs({ REMOTE_SSH_PORT: '2222', REMOTE_SSH_KEY: 'C:/keys/my key', REMOTE_SSH_KNOWN_HOSTS: 'C:/keys/known_hosts' });
  assert(args.includes('StrictHostKeyChecking=yes'));
  assert(args.includes('C:/keys/my key'));
  assert(args.includes('UserKnownHostsFile=C:/keys/known_hosts'));
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

test('tunnel startup retries interrupted connections and waits for the remote acknowledgement', { timeout: 10000 }, async () => {
  const runner = supervise();
  let attempts = 0;
  const retries = [];
  try {
    const child = await openTunnel({
      start: () => runner.start(process.execPath, ['-e', ++attempts < 3
        ? "process.stderr.write('Connection closed by server port 22'); process.exit(255)"
        : "process.stdout.write('@@MATRIUS_DEV_TUNNEL_READY\\n'); setInterval(() => {}, 1000)"], { stdio: ['pipe', 'pipe', 'pipe'] }),
      ssh: [], forwards: [], host: 'fixture', signal: new AbortController().signal,
      retryDelays: [1, 1], onRetry: (attempt) => retries.push(attempt),
    });
    assert.equal(attempts, 3);
    assert.deepEqual(retries, [2, 3]);
    assert.equal(child.exitCode, null);
  } finally { await runner.stop(); }
});

test('tunnel authentication failures stop startup without retries or API launch', { timeout: 10000 }, async () => {
  const runner = supervise();
  let attempts = 0;
  let apiStarted = false;
  try {
    await assert.rejects(async () => {
      await openTunnel({
        start: () => { attempts++; return runner.start(process.execPath,
          ['-e', "process.stderr.write('Permission denied (publickey)'); process.exit(255)"], { stdio: ['pipe', 'pipe', 'pipe'] }); },
        ssh: [], forwards: [], host: 'fixture', signal: new AbortController().signal,
        retryDelays: [1, 1], onRetry() {},
      });
      apiStarted = true;
    }, /Permission denied/);
    assert.equal(attempts, 1);
    assert.equal(apiStarted, false);
  } finally { await runner.stop(); }
});

test('cancelling a tunnel handshake closes its child and does not retry', { timeout: 10000 }, async () => {
  const runner = supervise();
  const abort = new AbortController();
  let child;
  const timer = setTimeout(() => abort.abort(new Error('fixture cancelled')), 50);
  try {
    await assert.rejects(openTunnel({
      start: () => { child = runner.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] }); return child; },
      ssh: [], forwards: [], host: 'fixture', signal: abort.signal,
    }), /fixture cancelled/);
    assert.notEqual(child.exitCode ?? child.signalCode, null);
  } finally { clearTimeout(timer); await runner.stop(); }
});

test('database tunnel readiness checks the protocol and rejects a closed forwarding channel', async (t) => {
  let closed = false;
  const server = net.createServer((socket) => {
    socket.once('data', (request) => {
      assert.equal(request.toString('hex'), '0000000804d2162f');
      if (closed) socket.end(); else socket.end('N');
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((accept) => server.close(accept)));
  await verifyDatabaseTunnel(server.address().port, new AbortController().signal);
  closed = true;
  await assert.rejects(verifyDatabaseTunnel(server.address().port, new AbortController().signal), /could not reach PostgreSQL/);
});

test('supervisor reports missing executables and cleans up surviving children', { timeout: 10000 }, async () => {
  const runner = supervise();
  try {
    runner.start('matrius-missing-command-fixture', [], { stdio: 'ignore' });
    assert.equal(await runner.finished, 1);
  } finally { await runner.stop(); }
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
