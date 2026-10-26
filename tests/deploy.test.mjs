import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { appEnvOverrides, canSync, createArchive,
  loadDeployEnv, main, PRODUCTION_PROXY_KEY, shellQuote, snapshot,
  validateConfig, validateProductionProxy } from '../scripts/deploy.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const config = {
  REMOTE_USER: 'dev', REMOTE_HOST: 'server', APP_PORT: '16666',
  REMOTE_ENV_FILE: '/srv/matrius/production.env',
};

test('source selection rejects secrets, traversal, generated files and unsafe file names', () => {
  for (const path of ['.env', '.env.local', '.env.remote.local', 'server/.env',
    'docker-compose/.env.production', 'private.key', '.aws/credentials', '.ssh/config',
    'node_modules/x.js', 'server/.venv/bin/python', 'server/.data/dev.db',
    'server/.data/files/upload.png', 'public/vendor/katex/a.css',
    '../outside', '/absolute', 'a/../outside', 'a\\b', 'a\nb', '.remote-sync-manifest']) {
    assert.equal(canSync(path), false, path);
  }
  for (const path of ['src/app/index.tsx', 'server/app/main.py', '.env.local.example',
    'docker-compose/.env.production.example', 'assets/a b.png']) assert.equal(canSync(path), true, path);
});

test('deployment settings come from .env.production with .env.local as an override', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'matrius-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await loadDeployEnv(dir), {});
  await mkdir(join(dir, 'docker-compose'));
  await writeFile(join(dir, 'docker-compose/.env.production'),
    'REMOTE_USER=deploy\nREMOTE_HOST=203.0.113.10\nAPP_PORT=16666\nAUTH_SESSION_TTL_SECONDS=100\n');
  assert.equal((await loadDeployEnv(dir)).APP_PORT, '16666');
  await writeFile(join(dir, '.env.local'), 'APP_PORT=3000\nINITIAL_ADMIN_USERNAME=admin\n');
  const merged = await loadDeployEnv(dir);
  assert.equal(merged.APP_PORT, '3000');
  assert.equal(merged.REMOTE_HOST, '203.0.113.10');
  assert.equal(merged.AUTH_SESSION_TTL_SECONDS, '100');
  assert.equal(merged.INITIAL_ADMIN_USERNAME, 'admin');
});

test('shared application settings are framed for the server and empty values skipped', () => {
  const encoded = Buffer.from('http://proxy.local:7890', 'utf8').toString('base64');
  assert.equal(appEnvOverrides({ WEBTOOL_PROXY_URL: 'http://proxy.local:7890', LOG_LEVEL: '',
    UNRELATED: 'ignored' }), `WEBTOOL_PROXY_URL ${encoded}`);
  assert.throws(() => appEnvOverrides({ LOG_LEVEL: 'a\nb' }), /LOG_LEVEL must be on one line/);
});

test('the production proxy must be container-reachable', () => {
  assert.equal(validateProductionProxy(''), '');
  assert.equal(validateProductionProxy('  http://host.docker.internal:7890  '),
    'http://host.docker.internal:7890');
  assert.equal(validateProductionProxy('socks5://proxy.internal:1080'), 'socks5://proxy.internal:1080');
  for (const value of ['http://127.0.0.1:7890', 'http://localhost:7890', 'http://[::1]:7890',
    'http://0.0.0.0:7890', 'http://[::ffff:127.0.0.1]:7890', 'ftp://proxy.internal:21',
    'not-a-url']) {
    assert.throws(() => validateProductionProxy(value), new RegExp(PRODUCTION_PROXY_KEY), value);
  }
});

test('SSH configuration rejects command injection and invalid origins / paths', async () => {
  assert.equal(validateConfig(config).url, 'http://server:16666');
  assert.equal(validateConfig(config).remoteSsh, 'dev@server');
  assert.equal(validateConfig({ REMOTE_USER: config.REMOTE_USER,
    REMOTE_HOST: config.REMOTE_HOST }).envFile, '');
  assert.equal(validateConfig({ REMOTE_USER: config.REMOTE_USER,
    REMOTE_HOST: config.REMOTE_HOST }).url, 'http://server:16666');
  for (const patch of [{ REMOTE_USER: '-oProxyCommand=bad' }, { REMOTE_HOST: 'host;bad' },
    { REMOTE_HOST: 'host/path' }, { REMOTE_USER: 'user:password' }, { REMOTE_HOST: '' },
    { REMOTE_ENV_FILE: 'relative.env' }, { REMOTE_WORKSPACE: '/' }, { REMOTE_SSH_PORT: '65536' },
    { APP_PORT: '0' }, { APP_PORT: '65536' }, { API_PORT: 'abc' }, { APP_HTTPS_PORT: '99999' },
    { INITIAL_ADMIN_USERNAME: 'admin' }, { INITIAL_ADMIN_USERNAME: 'admin', INITIAL_ADMIN_PASSWORD: 'a\nb' },
    { INITIAL_ADMIN_USERNAME: 'admin', INITIAL_ADMIN_PASSWORD: 'change-me' },
    { [PRODUCTION_PROXY_KEY]: 'http://127.0.0.1:7890' }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
  assert.equal(validateConfig({ ...config, [PRODUCTION_PROXY_KEY]: 'http://host.docker.internal:7890' })
    .productionProxy, 'http://host.docker.internal:7890');
  assert.equal(validateConfig({ ...config, INITIAL_ADMIN_USERNAME: 'admin',
    INITIAL_ADMIN_PASSWORD: 'x' }).adminPassword, 'x');
  assert.equal(validateConfig({ ...config, APP_PORT: '3000', API_PORT: '3001' }).appPort, '3000');
  if (process.platform !== 'win32') {
    assert.equal((await execute('sh', ['-c', `printf %s ${shellQuote("a'$(echo wrong) b")}`],
      { encoding: 'utf8' })).stdout, "a'$(echo wrong) b");
  }
});

test('snapshot includes uncommitted files, excludes ignored secrets and symlinks, detects deletions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'matrius-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await execute('git', ['init', '-q', dir]);
  await writeFile(join(dir, '.gitignore'), '*.ignored\n');
  await writeFile(join(dir, 'tracked.txt'), 'old');
  await mkdir(join(dir, 'tracked-directory'));
  await writeFile(join(dir, 'tracked-directory/passwd'), 'local');
  await execute('git', ['-C', dir, 'add', '.']);
  await writeFile(join(dir, '.env'), 'SECRET=value');
  await writeFile(join(dir, 'new.txt'), 'new');
  await writeFile(join(dir, 'secret.ignored'), 'secret');
  if (process.platform !== 'win32') {
    await symlink('/etc/passwd', join(dir, 'outside'));
    await rm(join(dir, 'tracked-directory'), { recursive: true });
    await symlink('/etc', join(dir, 'tracked-directory'));
  }
  const first = await snapshot(dir);
  assert(first.has('tracked.txt') && first.has('new.txt'));
  assert(!first.has('.env') && !first.has('secret.ignored') && !first.has('outside'));
  if (process.platform !== 'win32') assert(!first.has('tracked-directory/passwd'));
  await rm(join(dir, 'tracked.txt'));
  await writeFile(join(dir, 'new.txt'), 'modified');
  const next = await snapshot(dir);
  assert(!next.has('tracked.txt'));
  assert.notEqual(first.get('new.txt').hash, next.get('new.txt').hash);
});

test('remote deploys production once per invocation and locks concurrent sessions',
  { skip: process.platform === 'win32', timeout: 90000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'matrius-session-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const source = join(dir, 'local');
    const bin = join(dir, 'bin');
    const workspace = join(dir, 'remote');
    const envFile = join(dir, 'production.env');
    const dockerLog = join(dir, 'docker.log');
    const curlLog = join(dir, 'curl.log');
    await mkdir(source); await mkdir(bin);
    const serviceEnv = 'POSTGRES_PASSWORD=test-postgres\nREDIS_PASSWORD=test-redis\n'
      + 'RUSTFS_ACCESS_KEY=test-access\nRUSTFS_SECRET_KEY=test-secret\n';
    await writeFile(envFile, serviceEnv);
    await writeFile(join(bin, 'docker'), '#!/usr/bin/env bash\n'
      + 'printf "%s\\n" "$*" >> "$DOCKER_TEST_LOG"\n'
      + 'if [[ ${DOCKER_TEST_FRESH:-0} == 1 && " $* " == *" volume inspect "* ]]; then exit 1; fi\n'
      + 'if [[ " $* " == *" --entrypoint python api -c "* ]]; then exit 0; fi\n'
      + 'if [[ " $* " == *" --entrypoint cat api /data/backup-snapshot.db "* ]]; then printf snapshot; exit 0; fi\n'
      + 'case " $* " in *" ps "*) for service in caddy api web; do '
      + '[[ $service == "${DOCKER_TEST_STOPPED:-}" ]] || printf "%s\\n" "$service"; done ;;'
      + ' *" logs "*) printf "fake logs\\n" ;; esac\n');
    await chmod(join(bin, 'docker'), 0o755);
    await writeFile(join(bin, 'curl'), '#!/usr/bin/env bash\n'
      + 'printf "%s\\n" "$*" >> "$CURL_TEST_LOG"\n'
      + 'if [[ ${CURL_TEST_FAIL:-0} == 1 ]]; then exit 1; fi\n'
      + 'printf \'%s\\n\' \'{"service":"matrius","status":"ok"}\'\n');
    await chmod(join(bin, 'curl'), 0o755);
    await writeFile(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
    await chmod(join(bin, 'sleep'), 0o755);
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      DOCKER_TEST_LOG: dockerLog, CURL_TEST_LOG: curlLog,
    };
    const sessionScript = join(repo, 'scripts/remote/session.sh');
    const start = (extraEnv = {}) => spawn('bash', [sessionScript, workspace, envFile,
      'http://server:16666'], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    const collect = (child) => {
      let text = '';
      let errors = '';
      child.stdout.on('data', (chunk) => { text += chunk; });
      child.stderr.on('data', (chunk) => { errors += chunk; });
      return { get text() { return text; }, get errors() { return errors; } };
    };
    const waitForText = async (output, marker) => {
      for (let attempt = 0; attempt < 1500; attempt += 1) {
        if (output.text.includes(marker)) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      throw new Error(`Timed out waiting for ${marker}. stderr: ${output.errors}`);
    };
    const writeSource = async (files) => {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(source, path)), { recursive: true });
        if (content === null) await rm(join(source, path), { force: true });
        else await writeFile(join(source, path), content);
      }
    };
    const archiveFor = async (files, name) => {
      const current = new Map(Object.entries(files)
        .filter(([, content]) => content !== null)
        .map(([path, content]) => [path, { hash: content }]));
      const archive = join(dir, name);
      await createArchive(source, Object.keys(files).filter((path) => files[path] !== null), current, archive);
      return readFile(archive);
    };
    const sendFrame = async (child, payload) => {
      child.stdin.write(`SYNC ${payload.length}\n`);
      child.stdin.write(payload);
    };
    const deploy = async (files, extraEnv = {}) => {
      await writeSource(files);
      const child = start(extraEnv);
      const output = collect(child);
      const closed = once(child, 'close');
      await waitForText(output, '@@MATRIUS_REMOTE_READY');
      await sendFrame(child, await archiveFor(files, `payload-${Math.random()}.tar.gz`));
      await waitForText(output, '@@MATRIUS_REMOTE_SYNCED');
      child.stdin.end();
      const [code] = await closed;
      return { code, output };
    };

    // Representative production image build inputs.
    const initial = {
      'package.json': '{}', 'package-lock.json': '{}', 'Dockerfile.web': 'FROM node',
      'scripts/sync-katex.mjs': '// katex', 'server/pyproject.toml': '[project]',
      'server/uv.lock': 'lock', 'server/Dockerfile': 'FROM python',
      'server/scripts/select-index.py': '# indexes', 'server/scripts/install-python-deps.sh': '# deps',
      'server/app/main.py': 'first', 'old file.txt': 'stale',
      'docker-compose/docker-compose.yml': 'services: {}',
      'docker-compose/Caddyfile': ':80 {}',
      'scripts/remote/health.sh': await readFile(join(repo, 'scripts/remote/health.sh'), 'utf8'),
    };
    await writeSource(initial);
    const first = start();
    const firstOutput = collect(first);
    const firstClosed = once(first, 'close');
    await waitForText(firstOutput, '@@MATRIUS_REMOTE_READY');

    const other = start();
    const otherClosed = once(other, 'close');
    const otherOutput = collect(other);
    other.stdin.end();
    assert.equal((await otherClosed)[0], 1);
    assert.match(otherOutput.errors, /Another npm run deploy session/);

    await sendFrame(first, await archiveFor(initial, 'first.tar.gz'));
    await waitForText(firstOutput, '@@MATRIUS_REMOTE_SYNCED');
    first.stdin.end();
    assert.equal((await firstClosed)[0], 0, firstOutput.errors);
    assert.equal(await readFile(join(workspace, 'source/server/app/main.py'), 'utf8'), 'first');
    assert.equal((await stat(join(workspace, 'source/server/app'))).mode & 0o777, 0o755);
    assert.equal((await stat(join(workspace, 'source/server/app/main.py'))).mode & 0o777, 0o644);
    let commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --no-deps web api\n/);
    assert.doesNotMatch(commands, /--build/);
    assert.match(commands, /up -d --no-deps --force-recreate caddy\n/);
    assert.match(commands, /--entrypoint python api -c/);
    assert.match(commands, /--entrypoint cat api \/data\/backup-snapshot\.db/);
    assert.match(commands, /up -d --wait --wait-timeout 180 --remove-orphans --force-recreate api\n/);
    assert.doesNotMatch(commands, /postgres|redis|rustfs|openserp|--no-deps migrate/);
    assert(!commands.includes('remote.override.yml'));
    assert.match(await readFile(curlLog, 'utf8'), /\/api\/health/);

    await writeFile(dockerLog, '');
    const changed = { ...initial, 'server/app/main.py': 'second', 'old file.txt': null, 'src/new file.ts': 'hello' };
    const second = await deploy(changed);
    assert.equal(second.code, 0, second.output.errors);
    assert.equal(await readFile(join(workspace, 'source/server/app/main.py'), 'utf8'), 'second');
    assert.equal(await readFile(join(workspace, 'source/src/new file.ts'), 'utf8'), 'hello');
    await assert.rejects(readFile(join(workspace, 'source/old file.txt')), { code: 'ENOENT' });
    commands = await readFile(dockerLog, 'utf8');
    // Source changes must be included in rebuilt production images.
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --no-deps web api\n/);
    assert.equal(await readFile(envFile, 'utf8'), serviceEnv);
    assert.match(commands, /up -d --no-deps caddy\n/);
    assert.doesNotMatch(commands, /--force-recreate caddy/);

    // Frontend source changes also reach the production image build.
    const frontend = { ...changed, 'src/new file.ts': 'updated' };
    await writeFile(dockerLog, '');
    const frontendDeploy = await deploy(frontend);
    assert.equal(frontendDeploy.code, 0, frontendDeploy.output.errors);
    commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --no-deps web api\n/);

    // Docker handles dependency layer caching during builds.
    await writeFile(dockerLog, '');
    const dependency = { ...frontend, 'package-lock.json': '{"changed":true}' };
    const dependencyDeploy = await deploy(dependency);
    assert.equal(dependencyDeploy.code, 0, dependencyDeploy.output.errors);
    commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --no-deps web api\n/);

    // Repeated deploys still invoke cached builds and keep the services running.
    await writeFile(dockerLog, '');
    const repeated = await deploy(dependency);
    assert.equal(repeated.code, 0, repeated.output.errors);
    commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --no-deps web api\n/);

    // Bind-mounted Caddyfile edits require recreation even when Compose's service hash is unchanged.
    await writeFile(dockerLog, '');
    const caddyDeploy = await deploy({ ...dependency, 'docker-compose/Caddyfile': ':80 { respond 200 }' });
    assert.equal(caddyDeploy.code, 0, caddyDeploy.output.errors);
    commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, /up -d --no-deps --force-recreate caddy\n/);

    await writeFile(dockerLog, '');
    const successfulCaddy = await readFile(join(workspace, 'caddy-config.sha256'), 'utf8');
    const failingFiles = { ...changed, 'docker-compose/Caddyfile': ':80 { respond 503 }' };
    await writeSource(failingFiles);
    const failing = start({ CURL_TEST_FAIL: '1' });
    const failingOutput = collect(failing);
    const failingClosed = once(failing, 'close');
    await waitForText(failingOutput, '@@MATRIUS_REMOTE_READY');
    await sendFrame(failing, await archiveFor(failingFiles, 'failing.tar.gz'));
    failing.stdin.end();
    assert.equal((await failingClosed)[0], 1);
    assert.equal(await readFile(join(workspace, 'caddy-config.sha256'), 'utf8'), successfulCaddy);

    // Exercise the real npm entrypoint and SSH command quoting without a network connection.
    await writeFile(join(bin, 'ssh'), '#!/usr/bin/env bash\nfor arg do command=$arg; done\nexec bash -c "$command"\n');
    await chmod(join(bin, 'ssh'), 0o755);
    const cliEnv = { ...env, ...config, REMOTE_WORKSPACE: workspace, REMOTE_ENV_FILE: envFile,
      APP_PORT: '', API_PORT: '', APP_HTTPS_PORT: '' };
    await writeFile(dockerLog, '');
    await main({ args: [], env: cliEnv });
    assert.equal(await readFile(join(workspace, 'source/server/app/main.py'), 'utf8'),
      await readFile(join(repo, 'server/app/main.py'), 'utf8'));
    await assert.rejects(readFile(join(workspace, 'source/src/new file.ts')), { code: 'ENOENT' });
    commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --no-deps web api\n/);
    assert(!commands.includes('remote.override.yml'));

    // Every deploy backs up existing data and recreates the API so the
    // entrypoint applies migrations and refreshes the administrator password.
    await writeFile(dockerLog, '');
    await main({ args: [], env: cliEnv });
    commands = await readFile(dockerLog, 'utf8');
    const backupIndex = commands.indexOf('--entrypoint python api -c');
    const deployIndex = commands.indexOf('--force-recreate api');
    assert(backupIndex >= 0 && deployIndex > backupIndex);
    assert.match(commands, /--entrypoint cat api \/data\/backup-snapshot\.db/);
    assert.match(commands, /up -d --wait --wait-timeout 180 --remove-orphans --force-recreate api\n/);

    await writeFile(dockerLog, '');
    await assert.rejects(main({ args: [], env: { ...cliEnv, CURL_TEST_FAIL: '1' } }),
      /SSH session closed \(1\)/);
    await assert.rejects(main({ args: ['--publish'], env: cliEnv }), /takes no options/);
    await assert.rejects(main({ args: ['--once'], env: cliEnv }), /takes no options/);
  });

test('one deploy initializes new servers and reconciles services, ports and administrator credentials',
  { skip: process.platform === 'win32', timeout: 90000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'matrius-fresh-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    const workspace = join(dir, 'remote');
    const dockerLog = join(dir, 'docker.log');
    const curlLog = join(dir, 'curl.log');
    await mkdir(bin); await mkdir(workspace);
    await writeFile(join(bin, 'docker'), '#!/usr/bin/env bash\n'
      + 'printf "%s\\n" "$*" >> "$DOCKER_TEST_LOG"\n'
      + 'if [[ ${DOCKER_TEST_FRESH:-0} == 1 && " $* " == *" volume inspect "* ]]; then exit 1; fi\n'
      + 'if [[ " $* " == *" --entrypoint python api -c "* ]]; then exit 0; fi\n'
      + 'if [[ " $* " == *" --entrypoint cat api /data/backup-snapshot.db "* ]]; then printf snapshot; exit 0; fi\n'
      + 'if [[ " $* " == *" ps "* ]]; then printf "caddy\\napi\\nweb\\n"; fi\n');
    await chmod(join(bin, 'docker'), 0o755);
    await writeFile(join(bin, 'curl'), '#!/usr/bin/env bash\n'
      + 'printf "%s\\n" "$*" >> "$CURL_TEST_LOG"\n'
      + 'printf \'%s\\n\' \'{"service":"matrius","status":"ok"}\'\n');
    await chmod(join(bin, 'curl'), 0o755);
    await writeFile(join(bin, 'ssh'), '#!/usr/bin/env bash\nfor arg do command=$arg; done\nexec bash -c "$command"\n');
    await chmod(join(bin, 'ssh'), 0o755);
    const env = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`,
      DOCKER_TEST_LOG: dockerLog, CURL_TEST_LOG: curlLog, DOCKER_TEST_FRESH: '1',
      REMOTE_USER: config.REMOTE_USER, REMOTE_HOST: config.REMOTE_HOST,
      REMOTE_WORKSPACE: workspace, REMOTE_ENV_FILE: '',
      INITIAL_ADMIN_USERNAME: 'root', INITIAL_ADMIN_PASSWORD: 'custom-admin-password',
      APP_PORT: '3000', API_PORT: '3001', APP_HTTPS_PORT: '3443',
      // The local development proxy stays on this PC; only the production key is uploaded.
      WEBTOOL_PROXY_URL: 'http://127.0.0.1:7890',
      WEBTOOL_PROXY_URL_PRODUCTION: 'http://host.docker.internal:7890',
    };

    // The first deploy initializes a new server without a separate command.
    await main({ args: [], env });
    const generated = await readFile(join(workspace, 'production.env'), 'utf8');
    assert.doesNotMatch(generated, /POSTGRES_PASSWORD|REDIS_PASSWORD|RUSTFS_/);
    assert.match(generated, /^SQLITE_BUSY_TIMEOUT_MS=30000$/m);
    assert.match(generated, /^INITIAL_ADMIN_USERNAME=root$/m);
    assert.match(generated, /^INITIAL_ADMIN_PASSWORD=custom-admin-password$/m);
    assert.match(generated, /^APP_PORT=3000$/m);
    assert.match(generated, /^API_PORT=3001$/m);
    assert.match(generated, /^APP_HTTPS_PORT=3443$/m);
    assert.match(generated, /^SEARCH_TIMEOUT_SECONDS=8$/m);
    assert.match(generated, /^SEARCH_DDGS_TIMEOUT_SECONDS=4$/m);
    assert.match(generated, /^FETCH_TIMEOUT_SECONDS=45$/m);
    assert.match(generated, /^WEBTOOL_PROXY_URL=http:\/\/host\.docker\.internal:7890$/m);
    assert.doesNotMatch(generated, /127\.0\.0\.1:7890/);
    assert.equal((await stat(join(workspace, 'production.env'))).mode & 0o777, 0o600);
    assert.match(await readFile(join(workspace, 'initial-admin.txt'), 'utf8'),
      /username=root\npassword=custom-admin-password/);
    const commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --wait --wait-timeout 180 --remove-orphans --force-recreate api\n/);
    assert.doesNotMatch(commands, /--entrypoint python api -c/);
    assert(!commands.includes('INITIAL_ADMIN_PASSWORD=custom-admin-password'));
    assert.match(commands, /up -d --no-deps web api\n/);
    assert.match(commands, /up -d --no-deps --force-recreate caddy\n/);

    // The latest deployment owns the administrator password; existing data is
    // backed up before its migrations run.
    await writeFile(dockerLog, '');
    const other = { ...env, DOCKER_TEST_FRESH: '0',
      INITIAL_ADMIN_USERNAME: 'other', INITIAL_ADMIN_PASSWORD: 'other-password' };
    await main({ args: [], env: other });
    const replaced = await readFile(join(workspace, 'production.env'), 'utf8');
    assert.match(replaced, /^INITIAL_ADMIN_USERNAME=other$/m);
    assert.match(replaced, /^INITIAL_ADMIN_PASSWORD=other-password$/m);
    assert.equal((await stat(join(workspace, 'production.env'))).mode & 0o777, 0o600);
    const replacedCommands = await readFile(dockerLog, 'utf8');
    const backupIndex = replacedCommands.indexOf('--entrypoint python api -c');
    const deployIndex = replacedCommands.indexOf('--force-recreate api');
    assert(backupIndex >= 0 && deployIndex > backupIndex);
    assert.match(replacedCommands, /--entrypoint cat api \/data\/backup-snapshot\.db/);

    // Later runs keep the current configuration and do not churn Caddy.
    await writeFile(dockerLog, '');
    await main({ args: [], env: other });
    assert.equal(await readFile(join(workspace, 'production.env'), 'utf8'), replaced);
    const later = await readFile(dockerLog, 'utf8');
    assert.match(later, / build web api\n/);
    assert.match(later, /--entrypoint python api -c/);
    assert.match(later, /up -d --wait --wait-timeout 180 --remove-orphans --force-recreate api\n/);
    assert.match(later, /up -d --no-deps caddy\n/);
    assert.doesNotMatch(later, /--force-recreate caddy/);

    // Port changes apply on the same single command.
    await writeFile(dockerLog, '');
    await writeFile(curlLog, '');
    await main({ args: [], env: { ...other, APP_PORT: '4000' } });
    const updated = await readFile(join(workspace, 'production.env'), 'utf8');
    assert.match(updated, /^APP_PORT=4000$/m);
    assert.match(updated, /^API_PORT=3001$/m);
    assert.match(updated, /^INITIAL_ADMIN_PASSWORD=other-password$/m);
    assert.equal((await stat(join(workspace, 'production.env'))).mode & 0o777, 0o600);
    assert.match(await readFile(curlLog, 'utf8'), /:4000\/api\/health/);
    const portUpdate = await readFile(dockerLog, 'utf8');
    assert.match(portUpdate, /up -d --no-deps caddy\n/);
    assert.match(portUpdate, /--force-recreate api/);
  });
