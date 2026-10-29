import { spawn, execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'dev-password';

// A copied .env.local.example must not start with a placeholder password.
export function assertAdminPassword(env = {}) {
  if ((env.INITIAL_ADMIN_PASSWORD || '').trim().toLowerCase() === 'change-me') {
    throw new Error('INITIAL_ADMIN_PASSWORD is still "change-me". Set a real administrator password in .env.local.');
  }
}

export function devDataDir(directory = root) {
  return join(directory, 'server', '.data');
}

/** One administrator config for the development database and production init. */
export function devAdminCredentials(env = {}) {
  return {
    username: env.INITIAL_ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME,
    password: env.INITIAL_ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD,
  };
}

/**
 * SQLAlchemy's SQLite URL: three slashes plus the path. A POSIX absolute path
 * therefore starts with a fourth slash; a Windows path keeps its drive letter.
 */
export function sqliteUrl(file) {
  return `sqlite+aiosqlite:///${file.replaceAll('\\', '/')}`;
}

export function devPorts(env) {
  const ports = [env.DEV_WEB_PORT || '8081', env.DEV_API_PORT || '8000'].map((port) => {
    if (!/^[1-9]\d*$/u.test(port) || Number(port) > 65535) throw new Error('Invalid DEV_WEB_PORT or DEV_API_PORT.');
    return Number(port);
  });
  if (ports[0] === ports[1]) throw new Error('DEV_WEB_PORT and DEV_API_PORT must differ.');
  return ports;
}

export function devApiArgs(apiPort, platform = process.platform, host = '127.0.0.1') {
  const launch = platform === 'win32'
    ? ['python', 'scripts/dev-api.py']
    : ['uvicorn'];
  return ['run', '--no-sync', ...launch, 'app.main:app', '--host', host,
    '--port', String(apiPort), '--reload', '--reload-dir', 'app'];
}

/** The API can bind all interfaces for a phone while readiness still probes loopback. */
export function devApiHost(env = {}, target = 'web') {
  const host = (env.DEV_API_HOST || '').trim();
  if (host) return host;
  return target === 'ios' ? '0.0.0.0' : '127.0.0.1';
}

export function probeHost(host = '127.0.0.1') {
  const value = host.trim().toLowerCase();
  if (value === '0.0.0.0' || value === '::' || value === '[::]') return '127.0.0.1';
  return host.trim() || '127.0.0.1';
}

/** Expo CLI arguments for the web browser and for Expo Go on a phone or simulator. */
export function devExpoArgs({ target = 'web', platform = process.platform, port = 8081, host = '' } = {}) {
  if (target !== 'ios') return ['start', '--web', '--port', String(port)];
  if (platform === 'darwin') return ['start', '--ios', '--port', String(port)];
  const mode = host.trim().toLowerCase();
  // Windows and WSL cannot open the iOS Simulator: print a QR code for Expo Go instead.
  if (mode === 'tunnel') return ['start', '--tunnel'];
  if (mode === 'localhost') return ['start', '--localhost', '--port', String(port)];
  return ['start', '--lan', '--port', String(port)];
}

export function parseDevArgs(args = []) {
  const allowed = new Set(['--web', '--ios', '--check', '--reset-db', '--help']);
  const unknown = args.filter((arg) => !allowed.has(arg));
  if (unknown.length) throw new Error(`Unknown option: ${unknown[0]}. Use --help.`);
  const options = new Set(args);
  if (options.has('--web') && options.has('--ios')) throw new Error('Choose either --web or --ios.');
  return {
    target: options.has('--ios') ? 'ios' : 'web',
    check: options.has('--check'),
    resetDb: options.has('--reset-db'),
    help: options.has('--help'),
  };
}

/** The first non-loopback IPv4 address, which is the one a phone on the LAN can reach. */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const addresses of Object.values(interfaces ?? {})) {
    for (const address of addresses ?? []) {
      if ((address.family === 'IPv4' || address.family === 4) && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * Expo Go cannot use the web dev proxy, so the phone must call the API directly.
 * An explicit value from .env.local always wins; otherwise use this machine's LAN address.
 */
export function devApiBaseUrl({ env = {}, apiPort, target = 'web', interfaces } = {}) {
  const explicit = (env.EXPO_PUBLIC_API_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/u, '');
  const loopback = `http://127.0.0.1:${apiPort}`;
  if (target !== 'ios') return loopback;
  const ip = lanAddress(interfaces);
  return ip ? `http://${ip}:${apiPort}` : loopback;
}

export function devEnvironment({ env = {}, dataDir = devDataDir(), webPort }) {
  const admin = devAdminCredentials(env);
  return {
    ...env,
    APP_ENV: 'development',
    APP_URL: `http://localhost:${webPort}`,
    DATABASE_URL: sqliteUrl(join(dataDir, 'dev.db')),
    DATA_DIR: dataDir,
    INITIAL_ADMIN_USERNAME: admin.username,
    INITIAL_ADMIN_PASSWORD: admin.password,
  };
}

/**
 * The backend reads .env.local itself in development, so runtime settings (proxy,
 * search/fetch budgets, limits) apply without restarting uvicorn. Only startup-only
 * values are copied into the child environment; copying runtime keys here would freeze
 * them and keep overriding the file after an edit.
 */
export function devBackendEnv({ env = {}, local = {}, dataDir = devDataDir(), webPort, envFile }) {
  const environment = devEnvironment({ env, dataDir, webPort });
  const admin = devAdminCredentials(local);
  environment.INITIAL_ADMIN_USERNAME = admin.username;
  environment.INITIAL_ADMIN_PASSWORD = admin.password;
  if (envFile) environment.MATRIUS_DEV_ENV_FILE = resolve(envFile);
  return environment;
}

/**
 * Only the development database and its uploaded files may be removed. Targets
 * are fixed names inside DATA_DIR, so no user-supplied path can widen the blast
 * radius.
 */
export function resetTargets(dataDir = devDataDir()) {
  const base = resolve(dataDir);
  return [
    join(base, 'dev.db'),
    join(base, 'dev.db-wal'),
    join(base, 'dev.db-shm'),
    join(base, 'files'),
  ];
}

export async function resetDatabase(dataDir = devDataDir()) {
  for (const target of resetTargets(dataDir)) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
        throw new Error('Cannot reset the development database. Stop the running API (Ctrl+C) and try again.');
      }
      throw error;
    }
  }
  await mkdir(join(resolve(dataDir), 'files'), { recursive: true });
}

// Reserve/check loopback ports before starting children.
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
        failure ??= new Error(`${label} exited (${code}). Development services stopped; run npm run dev again.`);
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

function capture(command, args, signal, options = {}) {
  return new Promise((accept, reject) => {
    execFile(command, args,
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal, ...options },
      (error, stdout, stderr) => {
        if (error) {
          if (signal?.aborted) { reject(signal.reason); return; }
          const detail = String(stderr ?? '').split('\n').map((line) => line.trim())
            .filter(Boolean).slice(-3).join(' ');
          reject(new Error(`${command} failed${detail ? `: ${detail}` : ''}`));
        } else accept(stdout);
      });
  });
}

async function runBackend(args, env, signal) {
  return capture('uv', ['run', '--no-sync', ...args], signal, { cwd: join(root, 'server'), env });
}

async function ready(url, signal) {
  for (let attempt = 0; attempt < 90; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (response.ok) return;
    } catch { /* The API may still be importing the app. */ }
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error('Local API readiness failed. Check the uvicorn output above.');
}

export async function main({ args = process.argv.slice(2), env = process.env } = {}) {
  const options = parseDevArgs(args);
  if (options.help) {
    console.log('npm run dev [-- --web | --ios] [--check] [--reset-db]\n'
      + '--web (default) runs FastAPI + Expo Web on this machine.\n'
      + '--ios runs the same backend and opens Expo for iOS (Simulator on macOS, Expo Go QR elsewhere).\n'
      + 'Both targets run migrations, bootstrap the administrator and wait for /api/health/ready.\n'
      + 'Data lives in server/.data (SQLite + uploaded files) and is never synced to the server.\n'
      + 'Requires Node.js, npm ci and uv (uv installs Python 3.12 itself).\n'
      + '--check validates local configuration, tools, ports, API address and paths without starting services.\n'
      + '--reset-db deletes server/.data/dev.db* and server/.data/files before migrating; stop the API first.\n'
      + 'DEV_API_HOST, DEV_EXPO_HOST and EXPO_PUBLIC_API_BASE_URL in .env.local override defaults.\n'
      + 'The development administrator comes from INITIAL_ADMIN_* in .env.local\n'
      + '(defaults: admin / dev-password). Production env files are never read.');
    return;
  }
  const target = options.target;
  const readEnv = async (file) => {
    try { return parseEnv(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
  };
  const local = { ...await readEnv(join(root, '.env.local')), ...env };
  assertAdminPassword(local);
  const [webPort, apiPort] = devPorts(local);
  const dataDir = devDataDir();
  const { username: adminUser, password: adminPassword } = devAdminCredentials(local);
  const apiHost = devApiHost(local, target);
  const expoHost = (local.DEV_EXPO_HOST || '').trim();
  const apiBase = devApiBaseUrl({ env: local, apiPort, target });
  const expoArgs = devExpoArgs({ target, platform: process.platform, port: webPort, host: expoHost });

  await capture('uv', ['--version']).catch(() => {
    throw new Error('Install uv first: https://docs.astral.sh/uv/getting-started/installation/');
  });
  await readFile(join(root, 'node_modules/expo/bin/cli')).catch(() => { throw new Error('Run npm ci first.'); });

  if (options.check) {
    await availablePort(webPort);
    await availablePort(apiPort);
    console.log(`Configuration and tools valid. Target: ${target}; Expo port: ${webPort}; API: ${apiPort}.\n`
      + `API bind: ${apiHost} (readiness probes ${probeHost(apiHost)}).\n`
      + `Expo: ${expoArgs.join(' ')}.\n`
      + (target === 'ios'
        ? `Expo Go API base: ${apiBase}${local.EXPO_PUBLIC_API_BASE_URL ? ' (from .env.local)' : ''}.\n`
        : '')
      + `Data: ${join(dataDir, 'dev.db')} (SQLite) and ${join(dataDir, 'files')}.\n`
      + `Development admin: ${adminUser} (INITIAL_ADMIN_* in .env.local; defaults admin/dev-password).\n`
      + 'No network connection will be made by npm run dev.');
    return;
  }

  // Runtime settings stay in .env.local and are hot-read by the backend. Only
  // startup-only values (database location, admin bootstrap, env-file path) are copied
  // into the process environment; fixing DATABASE_URL/DATA_DIR here also keeps a
  // production path in .env.local from leaking into local development.
  const backendEnv = devBackendEnv({
    env, local, dataDir, webPort, envFile: join(root, '.env.local'),
  });

  const abort = new AbortController();
  const runner = supervise();
  const interrupt = () => { abort.abort(); void runner.stop(); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  // A crashed child must interrupt readiness/setup too.
  runner.finished.then(() => abort.abort(runner.failure));
  try {
    await availablePort(webPort);
    await availablePort(apiPort);
    console.log('Syncing local Python dependencies from server/uv.lock...');
    const sync = runner.start('uv', ['sync', '--python', '3.12', '--frozen', '--extra', 'dev'],
      { cwd: join(root, 'server') });
    if (await sync.done !== 0) throw new Error('uv sync failed.');

    if (options.resetDb) {
      console.log(`Resetting ${dataDir}...`);
      await resetDatabase(dataDir);
    }
    await mkdir(join(dataDir, 'files'), { recursive: true });

    abort.signal.throwIfAborted();
    console.log('Applying migrations to server/.data/dev.db...');
    await runBackend(['alembic', 'upgrade', 'head'], backendEnv, abort.signal);
    // Fails when models changed without a matching migration.
    await runBackend(['alembic', 'check'], backendEnv, abort.signal);
    console.log('Ensuring the development administrator exists...');
    await runBackend(['python', '-m', 'app.bootstrap'], {
      ...backendEnv,
      INITIAL_ADMIN_USERNAME: adminUser,
      INITIAL_ADMIN_PASSWORD: adminPassword,
    }, abort.signal);
    abort.signal.throwIfAborted();

    const api = runner.start('uv', devApiArgs(apiPort, process.platform, apiHost), { cwd: join(root, 'server'), env: backendEnv });
    runner.watch(api, 'FastAPI');
    await ready(`http://${probeHost(apiHost)}:${apiPort}/api/health/ready`, abort.signal);
    abort.signal.throwIfAborted();

    const publicEnv = Object.fromEntries(Object.entries(local).filter(([key]) => key.startsWith('EXPO_PUBLIC_')));
    const expoEnv = {
      ...env, ...publicEnv,
      MATRIUS_DEV_API_URL: `http://127.0.0.1:${apiPort}`,
      EXPO_NO_DOTENV: '1', BROWSER: 'none',
    };
    if (target === 'ios') expoEnv.EXPO_PUBLIC_API_BASE_URL = apiBase;
    const expo = runner.start(process.execPath, [join(root, 'node_modules/expo/bin/cli'), ...expoArgs],
      { cwd: root, env: expoEnv });
    runner.watch(expo, 'Expo');
    if (target === 'ios') {
      console.log(`Expo iOS: ${expoArgs.join(' ')}. API base for the phone: ${apiBase}.`);
      if (local.EXPO_PUBLIC_API_BASE_URL) {
        console.log('Using EXPO_PUBLIC_API_BASE_URL from .env.local.');
      } else if (expoHost.toLowerCase() === 'tunnel') {
        console.log('Expo tunnel only tunnels Metro. Set EXPO_PUBLIC_API_BASE_URL to an API address the phone can reach.');
      } else if (expoHost.toLowerCase() === 'localhost') {
        console.log('A phone cannot reach localhost. Use --lan or set EXPO_PUBLIC_API_BASE_URL.');
      } else if (apiBase.startsWith('http://127.0.0.1')) {
        console.log('No LAN IPv4 address found. Set EXPO_PUBLIC_API_BASE_URL to an API address the phone can reach.');
      } else {
        console.log(`Scan the QR code with Expo Go; the phone must reach ${apiBase}. `
          + 'WSL2 users may need Windows port forwarding for the API port.');
      }
    }
    console.log(`Development: ${target === 'ios' ? `Expo iOS (API ${apiBase})` : `http://localhost:${webPort}`}. `
      + `Data stays in ${dataDir}; sign in as ${adminUser}. Ctrl+C stops local services only.`);

    const code = await runner.finished;
    if (code) throw new Error('Development service stopped unexpectedly.');
  } catch (error) {
    if (!runner.stopping) throw runner.failure ?? error;
  } finally {
    abort.abort();
    await runner.stop();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
