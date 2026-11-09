import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { devBackendEnv, devDataDir } from './dev.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Migrate exactly the development database that `npm run dev` uses. Production
 * DATABASE_URL / DATA_DIR values in the shell or .env.local never leak in.
 */
export function migrationEnvironment({ env = process.env, local = {}, directory = root } = {}) {
  const dataDir = devDataDir(directory);
  return {
    dataDir,
    environment: devBackendEnv({
      env,
      local,
      dataDir,
      webPort: local.DEV_WEB_PORT || '8081',
      envFile: join(directory, '.env.local'),
    }),
  };
}

function capture(command, args, options) {
  return new Promise((accept, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? '').split('\n').map((line) => line.trim())
            .filter(Boolean).slice(-5).join(' ');
          reject(new Error(`${command} failed${detail ? `: ${detail}` : ''}`));
        } else accept(stdout);
      });
  });
}

async function readLocalEnv(file) {
  try { return parseEnv(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}

export async function migrate({ env = process.env, directory = root } = {}) {
  const local = { ...await readLocalEnv(join(directory, '.env.local')), ...env };
  const { dataDir, environment } = migrationEnvironment({ env, local, directory });
  const serverDir = join(directory, 'server');

  await capture('uv', ['--version']).catch(() => {
    throw new Error('Install uv first: https://docs.astral.sh/uv/getting-started/installation/');
  });
  await mkdir(join(dataDir, 'files'), { recursive: true });

  console.log('Syncing local Python dependencies from server/uv.lock...');
  await capture('uv', ['sync', '--python', '3.12', '--frozen', '--extra', 'dev'],
    { cwd: serverDir, env: environment });

  console.log(`Applying migrations to ${join(dataDir, 'matrius.db')}...`);
  await capture('uv', ['run', '--no-sync', 'python', 'scripts/migrate-dev-database.py', dataDir],
    { cwd: serverDir, env: environment });
  await capture('uv', ['run', '--no-sync', 'alembic', 'upgrade', 'head'],
    { cwd: serverDir, env: environment });
  // Fails when models changed without a matching migration.
  await capture('uv', ['run', '--no-sync', 'alembic', 'check'],
    { cwd: serverDir, env: environment });
  const revision = await capture('uv', ['run', '--no-sync', 'alembic', 'current'],
    { cwd: serverDir, env: environment });
  const current = revision.trim().split('\n').pop() || 'unknown';
  await capture('uv', ['run', '--no-sync', 'python', '-m', 'app.bootstrap'],
    { cwd: serverDir, env: environment });
  console.log(`Database is at head: ${current}`);
  return { dataDir, revision: current };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
