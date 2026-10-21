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
    'node_modules', '.venv', '__pycache__', '.pytest_cache', '.ruff_cache', 'dist', 'web-build',
    'ios', 'android'].includes(part))) return false;
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

export function validateConfig(env) {
  if (!env.REMOTE_SSH || !/^[\w][\w.@:[\]-]*$/u.test(env.REMOTE_SSH)) {
    throw new Error('Set REMOTE_SSH to an SSH alias or user@host in .env.local.');
  }
  const url = new URL(env.REMOTE_PUBLIC_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('REMOTE_PUBLIC_URL must be an http(s) origin, including the public port.');
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
  return { ...env, envFile, workspace, url: url.origin, adminUser, adminPassword,
    appPort, apiPort, httpsPort };
}

export async function main({ args: cliArgs = process.argv.slice(2), env = process.env } = {}) {
  const flags = new Set(cliArgs);
  if (flags.has('--help')) {
    console.log('npm run remote [-- --check | --init | --publish | --migrate]\n'
      + 'Copy .env.local.example to .env.local and configure SSH / public URL.\n'
      + 'Default: sync source, build production Web + API on the server, health-check, then exit.\n'
      + 'The first run also creates missing server secrets and initializes the database.\n'
      + 'The default deployment does not change the released feature manifest.\n'
      + '--check: validate local configuration and list source counts without SSH.\n'
      + '--init: force server infrastructure initialization and migrations before deploying.\n'
      + '--publish: deploy, then release this build\'s stable features after health checks pass.\n'
      + '--migrate: explicitly apply reviewed database migrations before deploying.');
    return;
  }
  if ([...flags].some((flag) => !['--check', '--init', '--publish', '--migrate'].includes(flag))) {
    throw new Error('Unknown option. Use --help.');
  }
  let fileEnv = {};
  try { fileEnv = parseEnv(await readFile(join(root, '.env.local'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = validateConfig({ ...fileEnv, ...env });
  const current = await snapshot(root);
  for (const required of ['package.json', 'package-lock.json', 'docker-compose/docker-compose.yml',
    'server/app/main.py']) {
    if (!current.has(required)) throw new Error(`Missing sync source: ${required}`);
  }
  if (flags.has('--check')) {
    const ports = [['APP_PORT', config.appPort], ['API_PORT', config.apiPort],
      ['APP_HTTPS_PORT', config.httpsPort]]
      .filter(([, value]) => value).map(([name, value]) => `${name}=${value}`);
    console.log(`Configuration valid. ${current.size} source files; credentials and dependencies excluded.\n`
      + `SSH: ${config.REMOTE_SSH}\nRemote site: ${config.url}\n`
      + `Ports: ${ports.length ? ports.join(', ') : 'server configuration defaults'}\n`
      + `Initial admin: ${config.adminUser || 'generated on first run'}\nNo server connection was made.`);
    return;
  }

  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
  if (config.REMOTE_SSH_PORT) args.push('-p', config.REMOTE_SSH_PORT);
  if (config.REMOTE_SSH_KEY) args.push('-i', config.REMOTE_SSH_KEY.replace(/^~(?=[/\\])/u, homedir()));
  if (config.REMOTE_SSH_KNOWN_HOSTS) args.push('-o', `UserKnownHostsFile=${config.REMOTE_SSH_KNOWN_HOSTS}`);
  const script = (await readFile(join(root, 'scripts/remote/session.sh'), 'utf8')).replaceAll('\r\n', '\n');
  const encoded = Buffer.from(script).toString('base64');
  const command = `bash -c "$(printf '%s' '${encoded}' | base64 -d)" -- `
    + [config.workspace, config.envFile, config.url, flags.has('--init') ? '1' : '0',
      flags.has('--publish') ? '1' : '0', flags.has('--migrate') ? '1' : '0',
      config.appPort, config.apiPort, config.httpsPort].map(shellQuote).join(' ');
  console.log(`Connecting to ${config.REMOTE_SSH}. Web/API will use the server's live data.`);
  const ssh = spawn('ssh', [...args, '--', config.REMOTE_SSH, command], { env, stdio: ['pipe', 'pipe', 'inherit'] });
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
      fail(new Error(`SSH session closed (${code}). Run npm run remote again to reconnect.`));
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
    ssh.stdin.write(`SYNC ${payload.length}\n`);
    ssh.stdin.write(payload);
    frameSent = true;
    await synced;
    console.log(flags.has('--publish')
      ? `Published. ${config.url} (feature releases updated)`
      : `Deployed. ${config.url} (feature releases unchanged)`);
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
