import { Buffer } from 'node:buffer';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

// Even accidentally tracked credentials / generated files must stay on this PC.
export function canSync(path) {
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return false;
  if (/[\r\n\0\\]/u.test(path)) return false;
  if (parts.some((part) => ['.git', '.ssh', '.aws', '.codex', '.agents', '.expo', '.remote',
    'node_modules', '.venv', '.data', '__pycache__', '.pytest_cache', '.ruff_cache', 'dist',
    'web-build', 'ios', 'android'].includes(part))) return false;
  if (path.startsWith('public/vendor/katex/') || path === '.remote-sync-manifest') return false;
  return !parts.some((part) => (part.startsWith('.env') && !part.endsWith('.example'))
    || /\.(?:pem|key|p12|p8|jks|db|sqlite|sqlite3|pyc|tsbuildinfo)$/iu.test(part)
    || /^(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/u.test(part));
}

export async function snapshot(directory) {
  const { stdout: output } = await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'],
    { cwd: directory, maxBuffer: 32 * 1024 * 1024 });
  const result = new Map();
  const safeDirectories = new Map();
  for (const path of output.toString('utf8').split('\0').filter(canSync)) {
    let safe = true;
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (!safeDirectories.has(parent)) {
        try { safeDirectories.set(parent, (await lstat(join(directory, parent))).isDirectory()); }
        catch (error) { if (error.code !== 'ENOENT') throw error; safeDirectories.set(parent, false); }
      }
      if (!safeDirectories.get(parent)) { safe = false; break; }
    }
    if (!safe) continue;
    let stat;
    try { stat = await lstat(join(directory, path)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) continue; // Never follow symlinks outside the workspace.
    const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
    const hash = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
    result.set(path, { signature, hash });
  }
  return result;
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${command} failed (${code}).`);
}

export async function createArchive(directory, files, current, destination) {
  const staging = await mkdtemp(join(tmpdir(), 'matrius-remote-'));
  try {
    // Prefixing ./ and NUL separation keep tar file lists literal, including spaces.
    await writeFile(join(staging, 'files'), files.map((path) => `./${path}\0`).join(''));
    // comm on the server uses byte order, independent of the development PC's locale.
    const manifest = [...current.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    await writeFile(join(staging, '.remote-sync-manifest'), `${manifest.join('\n')}\n`);
    await run('tar', ['-czf', destination, '-C', staging, '.remote-sync-manifest',
      '-C', directory, '--null', '-T', join(staging, 'files')]);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

// Application settings that are shared by local development and production.
// When present in .env.local, deploy writes them into the server's production.env.
export const APP_ENV_KEYS = [
  'AUTH_SESSION_TTL_SECONDS', 'MAX_UPLOAD_BYTES', 'STORAGE_QUOTA_BYTES',
  'FETCH_MAX_CHARS', 'SQLITE_BUSY_TIMEOUT_MS', 'CACHE_MAX_ENTRIES', 'CACHE_MAX_BYTES',
  'SEARCH_TIMEOUT_SECONDS', 'SEARCH_MAX_BYTES', 'FETCH_MAX_BYTES', 'SEARCH_PROXY_URL', 'LOG_LEVEL',
];

export async function readEnvFile(path) {
  try { return parseEnv(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

// Deployment settings belong in docker-compose/.env.production; .env.local is
// kept as an override for existing setups and for application settings.
export async function loadDeployEnv(directory = root) {
  return {
    ...await readEnvFile(join(directory, 'docker-compose', '.env.production')),
    ...await readEnvFile(join(directory, '.env.local')),
  };
}

// One `KEY <base64 value>` line per override. Empty values are skipped so an
// unset local key never rewrites the server configuration.
export function appEnvOverrides(env) {
  return APP_ENV_KEYS.flatMap((key) => {
    const value = env[key];
    if (value === undefined || value === '') return [];
    if (/[\r\n\0]/u.test(value)) throw new Error(`${key} must be on one line.`);
    return `${key} ${Buffer.from(value, 'utf8').toString('base64')}`;
  }).join('\n');
}

export function validateConfig(env) {
  const user = (env.REMOTE_USER || '').trim();
  const host = (env.REMOTE_HOST || '').trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(user)) {
    throw new Error('Set REMOTE_USER to the SSH account in docker-compose/.env.production.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/u.test(host)) {
    throw new Error('Set REMOTE_HOST to the server IP address in docker-compose/.env.production.');
  }
  const envFile = env.REMOTE_ENV_FILE || '';
  if (envFile && (!envFile.startsWith('/') || /[\r\n]/u.test(envFile))) {
    throw new Error('REMOTE_ENV_FILE must be an absolute server-side path when set.');
  }
  const workspace = env.REMOTE_WORKSPACE || '';
  if (workspace && (!workspace.startsWith('/') || workspace === '/' || /[\r\n]/u.test(workspace))) {
    throw new Error('REMOTE_WORKSPACE must be an absolute dedicated server directory.');
  }
  const adminUser = (env.INITIAL_ADMIN_USERNAME || '').trim();
  const adminPassword = env.INITIAL_ADMIN_PASSWORD || '';
  if (adminUser || adminPassword) {
    if (!adminUser || !adminPassword) {
      throw new Error('Set both INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD, or neither.');
    }
    if (adminUser.length > 64 || /[\r\n]/u.test(adminUser)) {
      throw new Error('INITIAL_ADMIN_USERNAME must be a single line of at most 64 characters.');
    }
    if (/[\r\n]/u.test(adminPassword)) {
      throw new Error('INITIAL_ADMIN_PASSWORD must be on one line.');
    }
    if (adminPassword.trim().toLowerCase() === 'change-me') {
      throw new Error('INITIAL_ADMIN_PASSWORD is still "change-me". Set a real administrator password in .env.local.');
    }
  }
  if (env.REMOTE_SSH_PORT && (!/^\d+$/u.test(env.REMOTE_SSH_PORT)
    || Number(env.REMOTE_SSH_PORT) < 1 || Number(env.REMOTE_SSH_PORT) > 65535)) {
    throw new Error('REMOTE_SSH_PORT must be a valid TCP port.');
  }
  const readPort = (name) => {
    const value = env[name] || '';
    if (value && (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535)) {
      throw new Error(`${name} must be a valid TCP port.`);
    }
    return value;
  };
  const appPort = readPort('APP_PORT');
  const apiPort = readPort('API_PORT');
  const httpsPort = readPort('APP_HTTPS_PORT');
  return { ...env, envFile, workspace, remoteSsh: `${user}@${host}`,
    url: `http://${host}:${appPort || '16666'}`, adminUser, adminPassword,
    appPort, apiPort, httpsPort };
}

export async function main({ args: cliArgs = process.argv.slice(2), env = process.env } = {}) {
  if (cliArgs.includes('--help')) {
    console.log('npm run deploy\n'
      + 'Copy docker-compose/.env.production.example to docker-compose/.env.production\n'
      + 'and configure SSH / public ports there. .env.local supplies application\n'
      + 'settings and the administrator password.\n'
      + 'Syncs source, builds production Web/API images, applies migrations, refreshes\n'
      + 'the administrator password, health-checks, then exits. The first deploy on a\n'
      + 'new server initializes the data volume, database and containers automatically.\n'
      + 'Stable features in the deployed code become available after health checks pass.');
    return;
  }
  if (cliArgs.length) throw new Error('npm run deploy takes no options. Use --help.');
  const localEnv = await readEnvFile(join(root, '.env.local'));
  const fileEnv = {
    ...await readEnvFile(join(root, 'docker-compose', '.env.production')),
    ...localEnv,
  };
  const config = validateConfig({ ...fileEnv, ...env });
  const appEnv = appEnvOverrides({ ...localEnv, ...env });
  const current = await snapshot(root);
  for (const required of ['package.json', 'package-lock.json', 'Dockerfile.web',
    'docker-compose/docker-compose.yml', 'docker-compose/Caddyfile', 'server/app/main.py',
    'server/scripts/entrypoint.sh']) {
    if (!current.has(required)) throw new Error(`Missing sync source: ${required}`);
  }
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  if (config.REMOTE_SSH_PORT) args.push('-p', config.REMOTE_SSH_PORT);
  if (config.REMOTE_SSH_KEY) args.push('-i', config.REMOTE_SSH_KEY.replace(/^~(?=[/\\])/u, homedir()));
  if (config.REMOTE_SSH_KNOWN_HOSTS) args.push('-o', `UserKnownHostsFile=${config.REMOTE_SSH_KNOWN_HOSTS}`);
  const script = (await readFile(join(root, 'scripts/remote/session.sh'), 'utf8')).replaceAll('\r\n', '\n');
  const encoded = Buffer.from(script).toString('base64');
  const command = `bash -c "$(printf '%s' '${encoded}' | base64 -d)" -- `
    + [config.workspace, config.envFile, config.url,
      config.appPort, config.apiPort, config.httpsPort].map(shellQuote).join(' ');
  console.log(`Connecting to ${config.remoteSsh}. Web/API will use the server's live data.`);
  const ssh = spawn('ssh', [...args, '--', config.remoteSsh, command], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let aborted = false;
  let frameSent = false;
  let stopRequested = false;
  let closed = false;
  let pending;
  const lines = createInterface({ input: ssh.stdout });
  const fail = (error) => { if (pending) { pending.reject(error); pending = undefined; } };
  ssh.on('error', fail);
  ssh.stdin.on('error', fail);
  const exit = new Promise((resolveExit) => {
    ssh.on('close', (code) => {
      closed = true;
      fail(new Error(`SSH session closed (${code}). Run npm run deploy again to reconnect.`));
      resolveExit(code);
    });
  });
  lines.on('line', (line) => {
    if (line === pending?.marker) { pending.resolve(); pending = undefined; }
    else console.log(line);
  });
  const waitFor = (marker) => new Promise((resolveWait, reject) => {
    if (closed) { reject(new Error('SSH session is closed.')); return; }
    pending = { marker, resolve: resolveWait, reject };
  });
  const stop = () => {
    if (frameSent && !stopRequested) {
      stopRequested = true;
      console.error('Deployment is running. Press Ctrl-C again to disconnect; the server may finish the deployment.');
      return;
    }
    aborted = true;
    fail(new Error('Remote deployment interrupted.'));
    ssh.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const ready = waitFor('@@MATRIUS_REMOTE_READY');
  const staging = await mkdtemp(join(tmpdir(), 'matrius-remote-session-'));
  let exitCode = 0;
  try {
    await ready;
    const files = [...current.keys()];
    console.log(`Syncing ${files.length} source files...`);
    const archive = join(staging, 'source.tar.gz');
    await createArchive(root, files, current, archive);
    const payload = await readFile(archive);
    const synced = waitFor('@@MATRIUS_REMOTE_SYNCED');
    const encode = (value) => (value ? Buffer.from(value, 'utf8').toString('base64') : '-');
    ssh.stdin.write(`CRED ${encode(config.adminUser)} ${encode(config.adminPassword)}\n`);
    ssh.stdin.write(`ENV ${encode(appEnv)}\n`);
    ssh.stdin.write(`SYNC ${payload.length}\n`);
    ssh.stdin.write(payload);
    frameSent = true;
    await synced;
    console.log(`Deployed. ${config.url}`);
  } catch (error) {
    if (!aborted) throw error;
  } finally {
    ssh.stdin.end();
    // Closing stdin releases the remote lock; app containers keep running.
    const killTimer = setTimeout(() => ssh.kill(), 5000);
    exitCode = await exit;
    clearTimeout(killTimer);
    lines.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await rm(staging, { recursive: true, force: true });
  }
  if (!aborted && exitCode !== 0) {
    throw new Error(`Remote deployment failed (${exitCode}).`);
  }
  console.log('Disconnected. Remote services keep running.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
