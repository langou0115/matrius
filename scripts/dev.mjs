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

export function devApiArgs(apiPort, platform = process.platform) {
  const launch = platform === 'win32'
    ? ['python', 'scripts/dev-api.py']
    : ['uvicorn'];
  return ['run', '--no-sync', ...launch, 'app.main:app', '--host', '127.0.0.1',
    '--port', String(apiPort), '--reload', '--reload-dir', 'app'];
}

/** Vite's CLI arguments; `--force` rebuilds the dependency pre-bundle before starting. */
export function devWebArgs(webPort, { clear = false } = {}) {
  return ['--port', String(webPort), '--strictPort', ...(clear ? ['--force'] : [])];
}

/** The agent service port; it must not collide with the web or API ports. */
export function devAgentPort(env = {}) {
  const raw = env.DEV_AGENT_PORT || '8123';
  if (!/^[1-9]\d*$/u.test(raw) || Number(raw) > 65535) throw new Error('Invalid DEV_AGENT_PORT.');
  const port = Number(raw);
  const [webPort, apiPort] = devPorts(env);
  if (port === webPort || port === apiPort) throw new Error('DEV_AGENT_PORT must differ from DEV_WEB_PORT and DEV_API_PORT.');
  return port;
}

/** The dev server reads the API and agent origins for its same-origin proxies. */
export function devWebEnv({ env = {}, apiPort, agentPort }) {
  return {
    ...env,
    MATRIUS_DEV_API_URL: `http://127.0.0.1:${apiPort}`,
    ...(agentPort ? { MATRIUS_DEV_AGENT_URL: `http://127.0.0.1:${agentPort}` } : {}),
  };
}

export function devEnvironment({ env = {}, dataDir = devDataDir(), webPort }) {
  return {
    ...env,
    APP_ENV: 'development',
    APP_URL: `http://localhost:${webPort}`,
    DATABASE_URL: sqliteUrl(join(dataDir, 'matrius.db')),
    DATA_DIR: dataDir,
  };
}

/**
 * The backend reads .env.local itself in development, so runtime settings (proxy,
 * search/fetch budgets, limits) apply without restarting uvicorn. Only startup-only
 * values are copied into the child environment; copying runtime keys here would freeze
 * them and keep overriding the file after an edit.
 */
export function devBackendEnv({ env = {}, dataDir = devDataDir(), webPort, envFile }) {
  const environment = devEnvironment({ env, dataDir, webPort });
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

async function ready(url, signal, { attempts = 90, label = 'Local API' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      if (response.ok) return;
    } catch { /* The service may still be importing its app. */ }
    await new Promise((accept) => setTimeout(accept, 500));
  }
  throw new Error(`${label} readiness failed. Check the service output above.`);
}

export async function main({ args = process.argv.slice(2), env = process.env } = {}) {
  if (args.includes('--help')) {
    console.log('npm run dev [-- --check | --reset-db | --clear]\n'
      + 'Runs FastAPI + Vite entirely on this machine; no Docker, SSH or WSL required.\n'
      + 'Data lives in server/.data (SQLite + uploaded files) and is never synced to the server.\n'
      + 'Requires Node.js, npm ci and uv (uv installs Python 3.12 itself).\n'
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
  const agentPort = devAgentPort(local);
  const dataDir = devDataDir();
  // Workspaces hoist `tsx` to the root; a legacy nested install is still accepted.
  const agentCli = [
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    join(root, 'agent', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ].find((path) => existsSync(path));

  await capture('uv', ['--version']).catch(() => {
    throw new Error('Install uv first: https://docs.astral.sh/uv/getting-started/installation/');
  });
  await readFile(join(root, 'node_modules/vite/bin/vite.js')).catch(() => { throw new Error('Run npm ci first.'); });
  if (!agentCli) throw new Error('Run npm ci first (the agent service runs outside the browser).');

  if (args.includes('--check')) {
    await availablePort(webPort);
    await availablePort(apiPort);
    await availablePort(agentPort);
    console.log(`Configuration and tools valid. Web: ${webPort}; API: ${apiPort}; Agent: ${agentPort}.\n`
      + `Data: ${join(dataDir, 'matrius.db')} (SQLite) and ${join(dataDir, 'files')}.\n`
      + `Single-user instance; no login required.\n`
      + 'No network connection will be made by npm run dev.');
    return;
  }

  // Runtime settings stay in .env.local and are hot-read by the backend. Only
  // startup-only values (database location, env-file path) are copied
  // into the process environment; fixing DATABASE_URL/DATA_DIR here also keeps a
  // production path in .env.local from leaking into local development.
  const backendEnv = devBackendEnv({
    env, dataDir, webPort, envFile: join(root, '.env.local'),
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

    if (args.includes('--reset-db')) {
      console.log(`Resetting ${dataDir}...`);
      await resetDatabase(dataDir);
    }
    await mkdir(join(dataDir, 'files'), { recursive: true });

    abort.signal.throwIfAborted();
    console.log('Applying migrations to server/.data/matrius.db...');
    await runBackend(['alembic', 'upgrade', 'head'], backendEnv, abort.signal);
    // Fails when models changed without a matching migration.
    await runBackend(['alembic', 'check'], backendEnv, abort.signal);
    console.log('Ensuring the singleton instance exists...');
    await runBackend(['python', '-m', 'app.bootstrap'], {
      ...backendEnv,
    }, abort.signal);
    abort.signal.throwIfAborted();

    const api = runner.start('uv', devApiArgs(apiPort), { cwd: join(root, 'server'), env: backendEnv });
    runner.watch(api, 'FastAPI');
    await ready(`http://127.0.0.1:${apiPort}/api/health/ready`, abort.signal);
    abort.signal.throwIfAborted();

    // The model loop lives in its own process; the browser only talks to it over HTTP.
    const agent = runner.start(process.execPath, [agentCli, 'src/server.ts'], {
      cwd: join(root, 'agent'),
      env: {
        ...process.env,
        AGENT_PORT: String(agentPort),
        MATRIUS_API_URL: `http://127.0.0.1:${apiPort}`,
      },
    });
    runner.watch(agent, 'Agent');
    // A cold install compiles the CopilotKit runtime on first import, which can take minutes.
    await ready(`http://127.0.0.1:${agentPort}/health`, abort.signal, { attempts: 480, label: 'Local agent' });
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
      { cwd: root, env: devWebEnv({ env, apiPort, agentPort }) });
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
