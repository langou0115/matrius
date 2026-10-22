import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { validateConfig } from './deploy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const services = ['postgres', 'redis', 'rustfs', 'openserp'];
const remotePorts = [5432, 6379, 9000, 7000];

export function sshArgs(config) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  if (config.REMOTE_SSH_PORT) args.push('-p', config.REMOTE_SSH_PORT);
  if (config.REMOTE_SSH_KEY) args.push('-i', config.REMOTE_SSH_KEY.replace(/^~(?=[/\\])/u, homedir()));
  if (config.REMOTE_SSH_KNOWN_HOSTS) args.push('-o', `UserKnownHostsFile=${config.REMOTE_SSH_KNOWN_HOSTS}`);
  return args;
}

export function devPorts(env) {
  const ports = [env.DEV_WEB_PORT || '8081', env.DEV_API_PORT || '8000'].map((port) => {
    if (!/^[1-9]\d*$/u.test(port) || Number(port) > 65535) throw new Error('Invalid DEV_WEB_PORT or DEV_API_PORT.');
    return Number(port);
  });
  if (ports[0] === ports[1]) throw new Error('DEV_WEB_PORT and DEV_API_PORT must differ.');
  return ports;
}

export function infrastructure(inspected) {
  return services.map((service, index) => {
    const container = inspected.find((item) => item.Name === `/matrius-${service}`);
    if (!container?.State?.Running) throw new Error(`matrius-${service} is not running. Initialize it with npm run deploy -- --init.`);
    const address = Object.values(container.NetworkSettings?.Networks ?? {}).map((item) => item.IPAddress).find(Boolean);
    if (!net.isIPv4(address)) throw new Error(`No IPv4 container address for matrius-${service}.`);
    const port = Number(container.Config?.Labels?.['io.matrius.dev.port'] ?? remotePorts[index]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port for matrius-${service}.`);
    const env = Object.fromEntries((container.Config?.Env ?? []).map((entry) => {
      const index = entry.indexOf('=');
      return [entry.slice(0, index), entry.slice(index + 1)];
    }));
    return { service, address, port, env };
  });
}

export function apiEnvironment(infra, ports, apiEnv = {}) {
  const [postgres, redis, rustfs] = infra.map((item) => item.env);
  for (const value of [postgres.POSTGRES_PASSWORD, redis.REDIS_PASSWORD, rustfs.RUSTFS_ACCESS_KEY, rustfs.RUSTFS_SECRET_KEY]) {
    if (!value) throw new Error('Missing infrastructure credentials; check server configuration.');
  }
  const encoded = encodeURIComponent;
  // Only backend runtime settings are inherited. Never copy bootstrap passwords.
  const allowed = ['RUSTFS_BUCKET', 'RUSTFS_REGION', 'OPENSERP_PROXY_URL', 'OPENSERP_PROXY_TAG',
    'AUTH_SESSION_TTL_SECONDS', 'PREVIEW_USERNAME', 'MAX_UPLOAD_BYTES', 'STORAGE_QUOTA_BYTES', 'FETCH_MAX_CHARS'];
  const inherited = Object.fromEntries(allowed.filter((key) => apiEnv[key] !== undefined).map((key) => [key, apiEnv[key]]));
  return {
    ...inherited, APP_ENV: 'development', LOG_LEVEL: 'INFO',
    DATABASE_URL: `postgresql+asyncpg://${encoded(postgres.POSTGRES_USER || 'postgres')}:${encoded(postgres.POSTGRES_PASSWORD)}@127.0.0.1:${ports[0]}/${encoded(postgres.POSTGRES_DB || postgres.POSTGRES_USER || 'postgres')}`,
    REDIS_URL: `redis://:${encoded(redis.REDIS_PASSWORD)}@127.0.0.1:${ports[1]}/0`,
    RUSTFS_ENDPOINT: `http://127.0.0.1:${ports[2]}`,
    RUSTFS_ACCESS_KEY: rustfs.RUSTFS_ACCESS_KEY, RUSTFS_SECRET_KEY: rustfs.RUSTFS_SECRET_KEY,
    OPENSERP_URL: `http://127.0.0.1:${ports[3]}`,
  };
}

// Reserve/check loopback ports before starting children. SSH fails closed if a port is stolen afterwards.
export async function availablePort(port = 0) {
  const server = net.createServer();
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  const result = server.address().port;
  await new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept()));
  return result;
}

export function supervise() {
  const children = new Set();
  let stopping = false;
  let cleanup;
  let stopped;
  let failure;
  const finished = new Promise((accept) => { stopped = accept; });
  const start = (command, args, options = {}) => {
    if (stopping) throw new Error('Development session is stopping.');
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true,
      detached: process.platform !== 'win32', ...options });
    children.add(child);
    child.done = new Promise((accept) => {
      child.once('error', (error) => {
        children.delete(child); accept(1);
        if (!stopping) { failure = new Error(`Cannot start ${command}: ${error.code}.`); stopped(1); }
      });
      child.once('close', (code) => { children.delete(child); accept(code ?? 1); });
    });
    return child;
  };
  const watch = (child, label) => {
    child.done.then((code) => {
      if (!stopping) {
        failure ??= new Error(`${label} exited (${code}). Development services stopped; run npm run dev to reconnect.`);
        stopped(code || 1);
      }
    });
  };
  const stop = () => {
    if (cleanup) return cleanup;
    stopping = true;
    stopped(0);
    cleanup = Promise.all([...children].map(async (child) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        await new Promise((accept) => execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'],
          { windowsHide: true }, (error) => {
            if (error) child.kill();
            accept();
          }));
        await child.done;
      } else {
        const signal = (name) => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
        signal('SIGTERM');
        const timer = setTimeout(() => signal('SIGKILL'), 3000);
        await child.done;
        clearTimeout(timer);
        // A reload worker may outlive its parent.
        signal('SIGKILL');
      }
    }));
    return cleanup;
  };
  return { start, watch, stop, finished, get stopping() { return stopping; }, get failure() { return failure; } };
}

const tunnelMarker = '@@MATRIUS_DEV_TUNNEL_READY';

export async function openTunnel({ start, ssh, forwards, host, signal, retryDelays = [1000, 3000],
  onRetry = (attempt) => console.log(`SSH connection was interrupted; retrying (${attempt}/3)...`) }) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    // Remote acknowledgement confirms authentication and local forwarding setup.
    // Keeping stdin open keeps this single remote command (and its forwards) alive.
    const child = start('ssh', [...ssh, '-o', 'ExitOnForwardFailure=yes', ...forwards, host,
      `printf '${tunnelMarker}\\n'; cat >/dev/null`], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let timer;
    let abort;
    const stderr = (chunk) => { errors = (errors + chunk).slice(-4096); };
    child.stderr.on('data', stderr);
    try {
      await new Promise((accept, reject) => {
        child.stdout.on('data', (chunk) => {
          output = (output + chunk).slice(-4096);
          if (output.includes(`${tunnelMarker}\n`)) accept();
        });
        child.done.then((code) => reject(new Error(`SSH connection exited (${code}). ${errors.trim()}`)));
        timer = setTimeout(() => reject(new Error('SSH connection timed out before forwarding was ready.')), 20000);
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      child.stderr.off('data', stderr);
      child.stderr.on('data', (chunk) => process.stderr.write(chunk));
      child.stdout.resume();
      child.stdin.on('error', () => {});
      return child;
    } catch (error) {
      child.kill();
      await child.done;
      signal.throwIfAborted();
      const transient = /Connection closed|Connection reset|timed out|Connection refused|kex_exchange/i.test(`${error.message} ${errors}`);
      if (!transient || attempt >= retryDelays.length) throw error;
      onRetry(attempt + 2);
      await delay(retryDelays[attempt], undefined, { signal });
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
}

export async function verifyDatabaseTunnel(port, signal) {
  signal.throwIfAborted();
  await new Promise((accept, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = (error) => {
      clearTimeout(timer); socket.destroy(); signal.removeEventListener('abort', abort);
      if (error) reject(error); else accept();
    };
    const fail = () => finish(new Error('SSH forwarding could not reach PostgreSQL. Check SSH forwarding permission and server connectivity.'));
    const abort = () => finish(signal.reason);
    const timer = setTimeout(fail, 5000);
    signal.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => socket.write(Buffer.from('0000000804d2162f', 'hex')));
    socket.once('data', (data) => ['S', 'N'].includes(data.toString()) ? finish() : fail());
    socket.once('error', fail);
    socket.once('end', fail);
    if (signal.aborted) abort();
  });
}

function capture(command, args, signal, input) {
  return new Promise((accept, reject) => {
    const child = execFile(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal }, (error, stdout) => {
      // execFile errors include captured stdout, which can contain credentials.
      if (error) {
        if (signal.aborted) { reject(signal.reason); return; }
        const detail = ['Connection closed', 'Connection reset', 'Connection timed out', 'Connection refused',
          'Permission denied', 'Host key verification failed'].find((text) => String(error.stderr).includes(text));
        const failure = new Error(`${command} failed${detail ? `: ${detail}` : ''}. Check SSH authentication, host trust and Docker access.`);
        failure.retryable = command === 'ssh' && /Connection (closed|reset|timed out|refused)/.test(detail ?? '');
        reject(failure);
      }
      else accept(stdout);
    });
    child.stdin.on('error', () => {}); // SSH can close before consuming the script.
    child.stdin.end(input);
  });
}

function parseRemoteJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw new Error(`Invalid ${label} from server.`); }
}

async function ready(url, signal) {
  for (let attempt = 0; attempt < 90; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (response.ok) return;
    } catch { /* API and SSH forwarding may still be starting. */ }
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error('Local API readiness failed. Check SSH forwarding permission and cloud service health.');
}

export async function main({ args = process.argv.slice(2), env = process.env } = {}) {
  if (args.includes('--help')) {
    console.log('npm run dev [-- --check]\nRuns local Expo + FastAPI with cloud infrastructure over SSH.\n'
      + 'Requires npm ci, uv, and SSH key authentication with TCP forwarding.\n'
      + '--check validates local configuration/tools without connecting or starting services.');
    return;
  }
  if (args.some((arg) => arg !== '--check')) throw new Error('Unknown option. Use --help.');
  let fileEnv = {};
  try { fileEnv = parseEnv(await readFile(join(root, '.env.local'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = validateConfig({ ...fileEnv, ...env });
  const [webPort, apiPort] = devPorts(config);
  const abort = new AbortController();
  await capture('uv', ['--version'], abort.signal).catch(() => { throw new Error('Install uv first: https://docs.astral.sh/uv/getting-started/installation/'); });
  await capture('ssh', ['-V'], abort.signal);
  await readFile(join(root, 'node_modules/expo/bin/cli')).catch(() => { throw new Error('Run npm ci first.'); });
  if (args.includes('--check')) {
    console.log(`Configuration and tools valid. SSH: ${config.remoteSsh}; Web: ${webPort}; API: ${apiPort}. No server connection made.`);
    return;
  }

  const runner = supervise();
  let temp;
  const interrupt = () => { abort.abort(); void runner.stop(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  // A tunnel or server failure interrupts readiness/setup too.
  runner.finished.then(() => abort.abort(runner.failure));
  try {
    await availablePort(webPort); await availablePort(apiPort);
    console.log('Preparing local Python dependencies from server/uv.lock...');
    const sync = runner.start('uv', ['sync', '--python', '3.12', '--frozen', '--extra', 'dev'], { cwd: join(root, 'server') });
    if (await sync.done !== 0) throw new Error('uv sync failed.');
    abort.signal.throwIfAborted();
    const ssh = sshArgs(config);
    console.log(`Reading cloud service connection settings from ${config.remoteSsh} (memory only)...`);
    const script = (await readFile(join(root, 'scripts/dev/discover.sh'), 'utf8')).replaceAll('\r\n', '\n');
    let metadata;
    for (let attempt = 0; ; attempt++) {
      try { metadata = await capture('ssh', [...ssh, config.remoteSsh, 'bash -s'], abort.signal, script); break; }
      catch (error) {
        if (!error.retryable || attempt >= 2) throw error;
        console.log(`SSH discovery was interrupted; retrying (${attempt + 2}/3)...`);
        await delay(attempt === 0 ? 1000 : 3000, undefined, { signal: abort.signal });
      }
    }
    const discovered = parseRemoteJson(metadata, 'runtime metadata');
    const infra = infrastructure(discovered.infrastructure);
    const cloudApi = discovered.api[0];
    const cloudEnv = Object.fromEntries((cloudApi?.Config?.Env ?? []).map((entry) => {
      const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)];
    }));
    const ports = [];
    for (let index = 0; index < infra.length; index++) {
      let port;
      do { port = await availablePort(); } while (ports.includes(port) || [webPort, apiPort].includes(port));
      ports.push(port);
    }
    const forwards = infra.flatMap((item, index) => ['-L', `127.0.0.1:${ports[index]}:${item.address}:${item.port}`]);
    const tunnel = await openTunnel({ start: runner.start, ssh, forwards, host: config.remoteSsh, signal: abort.signal });
    runner.watch(tunnel, 'SSH tunnel');
    await verifyDatabaseTunnel(ports[0], abort.signal);
    temp = await mkdtemp(join(tmpdir(), 'matrius-dev-'));
    // Match published stable features; preview access still goes through the backend registry.
    const parsed = discovered.releases;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('Invalid published feature manifest.');
    const localReleases = join(temp, 'features.json');
    await writeFile(localReleases, JSON.stringify(parsed));
    const backendEnv = { ...env, ...apiEnvironment(infra, ports, cloudEnv),
      APP_URL: `http://localhost:${webPort}`, FEATURE_RELEASES_FILE: localReleases };
    abort.signal.throwIfAborted();
    const api = runner.start('uv', ['run', '--no-sync', 'uvicorn', 'app.main:app', '--host', '127.0.0.1',
      '--port', String(apiPort), '--reload'], { cwd: join(root, 'server'), env: backendEnv });
    runner.watch(api, 'FastAPI');
    await ready(`http://127.0.0.1:${apiPort}/api/health/ready`, abort.signal);
    abort.signal.throwIfAborted();
    const expo = runner.start(process.execPath, [join(root, 'node_modules/expo/bin/cli'), 'start', '--web',
      '--port', String(webPort)], { cwd: root, env: { ...env, MATRIUS_DEV_API_URL: `http://127.0.0.1:${apiPort}`,
        EXPO_NO_DOTENV: '1', BROWSER: 'none' } });
    runner.watch(expo, 'Expo');
    console.log(`Development: http://localhost:${webPort}. Cloud data is shared with production. Ctrl+C stops local services only.`);
    const code = await runner.finished;
    if (code) throw new Error('Development service stopped unexpectedly.');
  } catch (error) {
    if (!runner.stopping) throw runner.failure ?? error;
  } finally {
    abort.abort();
    await runner.stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
