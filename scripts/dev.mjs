import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function devDataDir(directory = root) {
  return join(directory, 'server', '.data');
}

export function devPorts(env) {
  const ports = [env.DEV_WEB_PORT || '8081', env.DEV_API_PORT || '8000'].map((port) => {
    if (!/^[1-9]\d*$/u.test(port) || Number(port) > 65535) throw new Error('Invalid DEV_WEB_PORT or DEV_API_PORT.');
    return Number(port);
  });
  if (ports[0] === ports[1]) throw new Error('DEV_WEB_PORT and DEV_API_PORT must differ.');
  return ports;
}

/** Vite's CLI arguments; `--force` rebuilds the dependency pre-bundle before starting. */
export function devWebArgs(webPort, { clear = false } = {}) {
  return ['--port', String(webPort), '--strictPort', ...(clear ? ['--force'] : [])];
}

/** The dev server reads the API origin for its same-origin `/api/` proxy. */
export function devWebEnv({ env = {}, apiPort }) {
  return {
    ...env,
    MATRIUS_DEV_API_URL: `http://127.0.0.1:${apiPort}`,
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

async function ready(url, signal) {
  for (let attempt = 0; attempt < 90; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (response.ok) return;
    } catch { /* The API may still be importing the app. */ }
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error('Local API readiness failed. Check the Node API output above.');
}

export async function main({ args = process.argv.slice(2), env = process.env } = {}) {
  if (args.includes('--help')) {
    console.log('npm run dev [-- --check | --reset-db | --clear]\n'
      + 'Runs the Node API + Vite entirely on this machine; no Docker, SSH or WSL required.\n'
      + 'Data lives in server/.data (SQLite + uploaded files) and is never synced to the server.\n'
      + 'Requires Node.js and npm ci; no Python or uv is needed.\n'
      + '--check validates local configuration, tools, ports and paths without starting services.\n'
      + '--reset-db deletes server/.data/matrius.db* and server/.data/files before migrating; stop the API first.\n'
      + '--clear rebuilds Vite\'s dependency pre-bundle from scratch; use it after a dependency change.\n'
      + 'No login is required.\n'
      + 'Production env files are never read.');
    return;
  }
  if (args.some((arg) => !['--check', '--reset-db', '--clear'].includes(arg))) throw new Error('Unknown option. Use --help.');
  const readEnv = async (file) => {
    try { return parseEnv(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
  };
  const local = { ...await readEnv(join(root, '.env.local')), ...env };
  const [webPort, apiPort] = devPorts(local);
  const dataDir = devDataDir();

  await readFile(join(root, 'node_modules/vite/bin/vite.js')).catch(() => { throw new Error('Run npm ci first.'); });
  await readFile(join(root, 'node_modules/tsx/package.json')).catch(() => { throw new Error('Run npm ci first.'); });
  await readFile(join(root, 'server/main.ts')).catch(() => { throw new Error('Missing server/main.ts.'); });

  if (args.includes('--check')) {
    await availablePort(webPort);
    await availablePort(apiPort);
    console.log(`Configuration and tools valid. Web: ${webPort}; API: ${apiPort}.\n`
      + `Data: ${join(dataDir, 'matrius.db')} (SQLite) and ${join(dataDir, 'files')}.\n`
      + `Single-user instance; no login required.\n`
      + 'No network connection will be made by npm run dev.');
    return;
  }

  // Runtime settings stay in .env.local and are read by the Node API. Only
  // startup-only values (data directory, ports) are copied into the child
  // environment; a production path in .env.local must not leak into development.
  const backendEnv = {
    ...devEnvironment({ env, dataDir, webPort }),
    DATABASE_URL: '',
    HOST: '127.0.0.1',
    PORT: String(apiPort),
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
    const api = runner.start(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
      cwd: root,
      env: backendEnv,
    });
    runner.watch(api, 'Node API');
    await ready(`http://127.0.0.1:${apiPort}/api/health/ready`, abort.signal);
    abort.signal.throwIfAborted();

    // Vite starts in under a second, serves modules on demand and hot-replaces a
    // changed module without rebuilding the graph, so the development server needs
    // no worker or cache tuning of its own. The first run after `npm ci`, and the
    // first run after the lockfile or vite config changes, pre-bundles the frontend
    // dependencies; page requests wait for that pass, which is why it gets called out.
    if (!existsSync(join(root, 'node_modules', '.vite', 'deps', '_metadata.json'))) {
      console.log('Pre-bundling frontend dependencies (first run only; the page opens once it finishes)...');
    }
    const web = runner.start(process.execPath,
      [join(root, 'node_modules/vite/bin/vite.js'), ...devWebArgs(webPort, { clear: args.includes('--clear') })],
      { cwd: root, env: devWebEnv({ env, apiPort }) });
    runner.watch(web, 'Vite');
    console.log(`Development: http://localhost:${webPort}. Data stays in ${dataDir}; `
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
