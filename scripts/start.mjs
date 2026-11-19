import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { devDataDir, ready } from './dev.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readOptionalUtf8(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Resolve startup port, host and data directory from `.env.local` + process env. */
export async function resolveStartConfig({ root = defaultRoot, env = process.env } = {}) {
  const fileText = await readOptionalUtf8(join(root, '.env.local'));
  const merged = { ...(fileText ? parseEnv(fileText) : {}), ...env };
  const rawPort = String(merged.API_PORT || '8000').trim();
  if (!/^[1-9]\d*$/u.test(rawPort) || Number(rawPort) > 65_535) {
    throw new Error('Invalid API_PORT.');
  }
  const host = String(merged.HOST || '0.0.0.0').trim() || '0.0.0.0';
  return {
    apiPort: Number(rawPort),
    host,
    dataDir: devDataDir(merged, root),
    authEnabled: Boolean(String(merged.AUTH_SECRET ?? '').trim()),
  };
}

function spawnCommand(command, args, { cwd, env }) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit' });
  const done = new Promise((resolveExit, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolveExit({ code: code ?? 1, signal });
    });
  });
  return { child, done };
}

/** Run a full Vite production build into `dist/` before starting the server. */
export async function buildFrontend({ root = defaultRoot, env = process.env, onSpawn, runBuild } = {}) {
  console.log('Building frontend bundle (dist/)...');
  if (runBuild) {
    await runBuild();
  } else {
    const viteCli = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const { child, done } = spawnCommand(process.execPath, [viteCli, 'build'], { cwd: root, env });
    onSpawn?.(child);
    const result = await done;
    if (result.signal) return { signal: result.signal, code: result.code };
    if (result.code !== 0) {
      throw new Error(`Frontend build exited with code ${result.code}.`);
    }
  }
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    throw new Error('Frontend build completed without producing dist/index.html.');
  }
  return { code: 0, signal: null };
}

function readinessHost(host) {
  if (host === '0.0.0.0' || host === 'localhost') return '127.0.0.1';
  if (host === '::' || host === '::1') return '[::1]';
  return host;
}

export async function main({
  args = process.argv.slice(2),
  env = process.env,
  root = defaultRoot,
  runBuild,
  waitReady = ready,
} = {}) {
  if (args.includes('--help')) {
    console.log('npm run start\n'
      + 'Runs a full frontend build (`vite build`), then starts the single-process Node server.\n'
      + 'Reads .env.local (API_PORT default 8000, AUTH_SECRET, DATA_DIR, etc.) and serves UI + /api/*.');
    return;
  }
  if (args.length > 0) {
    throw new Error('Unknown option. Use --help.');
  }

  const viteCli = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverMain = join(root, 'server', 'main.ts');
  if (!existsSync(viteCli) || !existsSync(tsxCli)) {
    throw new Error('Missing dependencies. Run npm ci first.');
  }
  if (!existsSync(serverMain)) {
    throw new Error('Missing server/main.ts.');
  }

  const config = await resolveStartConfig({ root, env });
  let activeChild = null;
  let stopping = false;
  const abort = new AbortController();
  const forwardSignal = (signal) => {
    stopping = true;
    abort.abort(new Error(`Interrupted by ${signal}.`));
    if (activeChild && !activeChild.killed) {
      activeChild.kill(signal);
    }
  };
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);

  try {
    const buildResult = await buildFrontend({
      root,
      env,
      runBuild,
      onSpawn: (child) => { activeChild = child; },
    });
    activeChild = null;
    if (stopping || buildResult.signal) {
      if (buildResult.signal) process.kill(process.pid, buildResult.signal);
      return;
    }

    const server = spawnCommand(process.execPath, [tsxCli, serverMain], {
      cwd: root,
      env: { ...env, APP_ENV: env.APP_ENV || 'production' },
    });
    activeChild = server.child;
    let earlyResult = null;
    server.done.then((result) => {
      earlyResult = result;
      abort.abort(new Error(`Server exited before becoming ready (${result.signal ?? result.code}).`));
    });

    try {
      const probeUrl = `http://${readinessHost(config.host)}:${config.apiPort}/api/health/ready`;
      await waitReady(probeUrl, abort.signal);
    } catch (error) {
      if (stopping) {
        const result = await server.done;
        if (result.signal) process.kill(process.pid, result.signal);
        return;
      }
      if (earlyResult) {
        process.exitCode = earlyResult.code;
        return;
      }
      if (activeChild && !activeChild.killed) activeChild.kill('SIGTERM');
      await server.done;
      throw error;
    }

    const authSummary = config.authEnabled ? 'splash auth enabled' : 'no login required';
    console.log(`Matrius ready: http://localhost:${config.apiPort} (http://${readinessHost(config.host)}:${config.apiPort}). `
      + `Data: ${config.dataDir}; ${authSummary}. Ctrl+C stops server.`);

    const result = await server.done;
    activeChild = null;
    if (result.signal) {
      process.kill(process.pid, result.signal);
      return;
    }
    process.exitCode = result.code;
  } finally {
    abort.abort();
    process.off('SIGINT', forwardSignal);
    process.off('SIGTERM', forwardSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
