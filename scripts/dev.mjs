import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Startup data directory. DATA_DIR from .env.local or the shell wins; otherwise
 * the API's own default applies: ~/.matrius for SQLite and uploaded files.
 */
export function devDataDir(env = {}, directory = root) {
  const configured = String(env.DATA_DIR ?? '').trim();
  if (!configured) return join(homedir(), '.matrius');
  const expanded = configured === '~'
    ? homedir()
    : configured.startsWith('~/') || configured.startsWith('~\\')
      ? join(homedir(), configured.slice(2))
      : configured;
  return resolve(directory, expanded);
}

export function devPorts(env) {
  const ports = [env.WEB_PORT || '8081', env.API_PORT || '8000'].map((port) => {
    if (!/^[1-9]\d*$/u.test(port) || Number(port) > 65535) throw new Error('Invalid WEB_PORT or API_PORT.');
    return Number(port);
  });
  if (ports[0] === ports[1]) throw new Error('WEB_PORT and API_PORT must differ.');
  return ports;
}

/** Vite's CLI arguments; `--force` rebuilds the dependency pre-bundle before starting. */
export function devWebArgs(webPort, { clear = false } = {}) {
  return ['--port', String(webPort), '--strictPort', ...(clear ? ['--force'] : [])];
}

/** Resolve UI target (`web` by default; `--desktop` or `MATRIUS_TARGET=desktop` enables Desktop UI). */
export function devTarget(args = [], env = {}) {
  const hasDesktop = args.includes('--desktop');
  const hasWeb = args.includes('--web');
  if (hasDesktop && hasWeb) throw new Error('Cannot combine --desktop and --web.');
  if (hasDesktop) return 'desktop';
  if (hasWeb) return 'web';
  const raw = String(env.VITE_MATRIUS_TARGET ?? env.MATRIUS_TARGET ?? '').trim().toLowerCase();
  return raw === 'desktop' ? 'desktop' : 'web';
}

/** The dev server reads the API origin and target for its same-origin `/api/` proxy and UI gate. */
export function devWebEnv({ env = {}, apiPort, target = 'web' }) {
  return {
    ...env,
    MATRIUS_DEV_API_URL: `http://127.0.0.1:${apiPort}`,
    VITE_MATRIUS_TARGET: target,
  };
}

export function devEnvironment({ env = {}, dataDir = devDataDir(), webPort }) {
  return {
    ...env,
    APP_ENV: 'development',
    APP_URL: `http://localhost:${webPort}`,
    DATABASE_URL: '',
    DATA_DIR: dataDir,
  };
}

/**
 * Only the development database and its uploaded files may be removed. Targets
 * are fixed names inside DATA_DIR, so no user-supplied path can widen the blast
 * radius.
 */
export function resetTargets(dataDir = devDataDir()) {
  const base = resolve(dataDir);
  return [
    join(base, 'matrius.db'),
    join(base, 'matrius.db-wal'),
    join(base, 'matrius.db-shm'),
    join(base, 'files'),
    join(base, 'drafts'),
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

export async function ready(url, signal, label = 'Node API') {
  const startedAt = Date.now();
  let announced = false;
  // Use elapsed time: connection timeouts must count toward the deadline too.
  const deadline = startedAt + 120_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now())))]) });
      await response.body?.cancel();
      if (response.ok) {
        console.log(`${label} ready in ${((Date.now() - startedAt) / 1000).toFixed(2)}s.`);
        return;
      }
    } catch { /* The API may still be importing the app. */ }
    if (!announced && Date.now() - startedAt > 20_000) {
      announced = true;
      console.log(`${label} is still starting; waiting up to two minutes...`);
    }
    await delay(Math.max(1, Math.min(500, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`${label} readiness failed after two minutes. Check its output above.`);
}

export async function main({ args = process.argv.slice(2), env = process.env } = {}) {
  if (args.includes('--help')) {
    console.log('npm run dev [-- --web | --desktop | --check | --reset-db | --clear]\n'
      + 'Runs the Node API + Vite entirely on this machine; no SSH or WSL required.\n'
      + 'Data lives in ~/.matrius by default (SQLite + uploaded files); set DATA_DIR in .env.local to override.\n'
      + 'Requires Node.js and npm ci; no Python or uv is needed.\n'
      + '--web launches the Web UI (default for `npm run dev` and `npm run dev:web`, without desktop-only work tab).\n'
      + '--desktop launches the Desktop UI preview (`npm run dev:desktop`, showing the desktop-only work switcher).\n'
      + '--check validates local configuration, tools, ports and paths without starting services.\n'
      + '--reset-db deletes matrius.db* and files in the active data directory before migrating; stop the API first.\n'
      + '--clear rebuilds Vite\'s dependency pre-bundle from scratch; use it after a dependency change.\n'
      + 'No login is required.\n'
      + 'Production env files are never read.');
    return;
  }
  const knownOptions = ['--check', '--reset-db', '--clear', '--desktop', '--web'];
  if (args.some((arg) => !knownOptions.includes(arg))) throw new Error('Unknown option. Use --help.');
  const target = devTarget(args, env);
  const readEnv = async (file) => {
    try { return parseEnv(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
  };
  const local = target === 'desktop' ? env : { ...await readEnv(join(root, '.env.local')), ...env };
  const [webPort, apiPort] = devPorts(local);
  const dataDir = devDataDir(local);

  await readFile(join(root, 'node_modules/vite/bin/vite.js')).catch(() => { throw new Error('Run npm ci first.'); });
  await readFile(join(root, 'node_modules/tsx/package.json')).catch(() => { throw new Error('Run npm ci first.'); });
  await readFile(join(root, 'server/main.ts')).catch(() => { throw new Error('Missing server/main.ts.'); });

  if (args.includes('--check')) {
    await availablePort(webPort);
    await availablePort(apiPort);
    console.log(`Configuration and tools valid. Target: ${target}; Web: ${webPort}; API: ${apiPort}.\n`
      + `Data: ${join(dataDir, 'matrius.db')} (SQLite) and ${join(dataDir, 'files')}.\n`
      + `Single-user instance; no login required.\n`
      + 'No network connection will be made by npm run dev.');
    return;
  }

  // Runtime settings stay in .env.local and are read by the Node API. Only
  // startup-only values (data directory, ports) are copied into the child
  // environment; DATABASE_URL is cleared so a production URL never leaks.
  const backendEnv = {
    ...devEnvironment({ env, dataDir, webPort }),
    MATRIUS_DESKTOP_DEV: target === 'desktop' ? 'true' : 'false',
    DATABASE_URL: '',
    HOST: '127.0.0.1',
    API_PORT: String(apiPort),
  };

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
    if (args.includes('--reset-db')) {
      console.log(`Resetting ${dataDir}...`);
      await resetDatabase(dataDir);
    }
    await mkdir(join(dataDir, 'files'), { recursive: true });

    abort.signal.throwIfAborted();
    const api = runner.start(process.execPath, ['--enable-source-maps', 'scripts/dev-server.mjs'], {
      cwd: root,
      env: backendEnv,
    });
    runner.watch(api, 'Node API');
    // Start Vite while the API imports/migrates so dependency optimization and
    // first-screen warmup overlap backend startup, especially on cold Windows runs.
    if (!existsSync(join(root, 'node_modules', '.vite', 'deps', '_metadata.json'))) {
      console.log('Pre-bundling frontend dependencies (first run only; the page opens once it finishes)...');
    }
    const web = runner.start(process.execPath,
      [join(root, 'node_modules/vite/bin/vite.js'), ...devWebArgs(webPort, { clear: args.includes('--clear') })],
      { cwd: root, env: devWebEnv({ env, apiPort, target }) });
    runner.watch(web, 'Vite');
    await Promise.all([
      ready(`http://127.0.0.1:${apiPort}/api/health/ready`, abort.signal),
      ready(`http://127.0.0.1:${webPort}/`, abort.signal, 'Vite'),
    ]);
    abort.signal.throwIfAborted();
    console.log(`Development (${target}): http://localhost:${webPort}. Data stays in ${dataDir}; `
      + `no login is required. Ctrl+C stops local services only.`);
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
