import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { canSync, createArchive, main, shellQuote, snapshot, validateConfig } from '../scripts/remote.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const config = {
  REMOTE_USER: 'dev', REMOTE_HOST: 'server', APP_PORT: '16666',
  REMOTE_ENV_FILE: '/srv/matrius/production.env',
};

test('source selection rejects secrets, traversal, generated files and unsafe file names', () => {
  for (const path of ['.env', '.env.local', '.env.remote.local', 'server/.env',
    'docker-compose/.env.production', 'private.key', '.aws/credentials', '.ssh/config',
    'node_modules/x.js', 'server/.venv/bin/python', 'public/vendor/katex/a.css',
    '../outside', '/absolute', 'a/../outside', 'a\\b', 'a\nb', '.remote-sync-manifest']) {
    assert.equal(canSync(path), false, path);
  }
  for (const path of ['src/app/index.tsx', 'server/app/main.py', '.env.local.example',
    'docker-compose/.env.production.example', 'assets/a b.png']) assert.equal(canSync(path), true, path);
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
    { INITIAL_ADMIN_USERNAME: 'admin' }, { INITIAL_ADMIN_USERNAME: 'admin', INITIAL_ADMIN_PASSWORD: 'a\nb' }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
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

test('remote deploys production once per invocation, gates releases and locks concurrent sessions',
  { skip: process.platform === 'win32', timeout: 60000 }, async (t) => {
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
      + 'case " $* " in *" ps "*) printf "caddy\\npostgres\\nredis\\nrustfs\\nopenserp\\n" ;;'
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
    const start = (flags = [], extraEnv = {}) => spawn('bash', [sessionScript, workspace, envFile,
      'http://server:16666', ...flags], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
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
    const deploy = async (files, flags = [], extraEnv = {}) => {
      await writeSource(files);
      const child = start(flags, extraEnv);
      const output = collect(child);
      const closed = once(child, 'close');
      await waitForText(output, '@@MATRIUS_REMOTE_READY');
      await sendFrame(child, await archiveFor(files, `payload-${Math.random()}.tar.gz`));
      await waitForText(output, '@@MATRIUS_REMOTE_SYNCED');
      child.stdin.end();
      const [code] = await closed;
      return { code, output };
    };

    // These are the only inputs that trigger an image rebuild.
    const initial = {
      'package.json': '{}', 'package-lock.json': '{}', 'Dockerfile.web.dev': 'FROM node',
      'scripts/sync-katex.mjs': '// katex', 'server/pyproject.toml': '[project]',
      'server/uv.lock': 'lock', 'server/Dockerfile': 'FROM python',
      'server/scripts/select-index.py': '# indexes', 'server/scripts/install-python-deps.sh': '# deps',
      'server/app/main.py': 'first', 'old file.txt': 'stale',
      'docker-compose/docker-compose.yml': 'services: {}',
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
    assert.match(otherOutput.errors, /Another npm run remote session/);

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
    assert(!commands.includes('app.features.release'));
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
    // Mounted source is picked up by the watchers; no image build or restart.
    assert(!commands.includes(' build '));
    assert.match(commands, /up -d --no-deps web api\n/);
    assert(!commands.includes('app.features.release'));
    assert.equal(await readFile(envFile, 'utf8'), serviceEnv);

    // Frontend-only changes take the same mounted path: no rebuild at all.
    const frontend = { ...changed, 'src/new file.ts': 'updated' };
    await writeFile(dockerLog, '');
    const frontendDeploy = await deploy(frontend);
    assert.equal(frontendDeploy.code, 0, frontendDeploy.output.errors);
    commands = await readFile(dockerLog, 'utf8');
    assert(!commands.includes(' build '));
    assert.match(commands, /up -d --no-deps web api\n/);

    // Dependency changes rebuild only the affected image.
    await writeFile(dockerLog, '');
    const dependency = { ...frontend, 'package-lock.json': '{"changed":true}' };
    const dependencyDeploy = await deploy(dependency);
    assert.equal(dependencyDeploy.code, 0, dependencyDeploy.output.errors);
    commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web\n/);
    assert.doesNotMatch(commands, / build api\n/);
    assert.match(commands, /up -d --no-deps web api\n/);

    // Nothing changed: no image build at all, but both containers stay running.
    await writeFile(dockerLog, '');
    const repeated = await deploy(dependency);
    assert.equal(repeated.code, 0, repeated.output.errors);
    commands = await readFile(dockerLog, 'utf8');
    assert(!commands.includes(' build '));
    assert.match(commands, /up -d --no-deps web api\n/);

    await writeFile(dockerLog, '');
    const published = await deploy(changed, ['0', '1', '0']);
    assert.equal(published.code, 0, published.output.errors);
    assert.match(await readFile(dockerLog, 'utf8'), /-m app.features.release/);

    await writeFile(dockerLog, '');
    await writeSource(changed);
    const failing = start(['0', '1', '0'], { CURL_TEST_FAIL: '1' });
    const failingOutput = collect(failing);
    const failingClosed = once(failing, 'close');
    await waitForText(failingOutput, '@@MATRIUS_REMOTE_READY');
    await sendFrame(failing, await archiveFor(changed, 'failing.tar.gz'));
    failing.stdin.end();
    assert.equal((await failingClosed)[0], 1);
    assert(!(await readFile(dockerLog, 'utf8')).includes('app.features.release'));

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
    assert(!commands.includes('app.features.release'));
    assert(!commands.includes('remote.override.yml'));

    await writeFile(dockerLog, '');
    await main({ args: ['--init'], env: cliEnv });
    commands = await readFile(dockerLog, 'utf8');
    assert(!commands.includes(' build '));
    assert.match(commands, /--wait --wait-timeout 180 postgres redis rustfs openserp\n/);
    assert.match(commands, /run -T --rm --no-deps migrate\n/);
    assert(!commands.includes('app.features.release'));

    await writeFile(dockerLog, '');
    await main({ args: ['--publish'], env: cliEnv });
    commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, /up -d --no-deps web api\n/);
    assert.match(commands, /-m app.features.release/);

    await writeFile(dockerLog, '');
    await main({ args: ['--publish', '--migrate'], env: cliEnv });
    commands = await readFile(dockerLog, 'utf8');
    const migrateIndex = commands.indexOf('run -T --rm --no-deps migrate');
    const deployIndex = commands.indexOf('up -d --no-deps web api');
    assert(migrateIndex >= 0 && deployIndex > migrateIndex);

    await writeFile(dockerLog, '');
    await assert.rejects(main({ args: ['--publish'], env: { ...cliEnv, CURL_TEST_FAIL: '1' } }),
      /SSH session closed \(1\)/);
    assert(!(await readFile(dockerLog, 'utf8')).includes('app.features.release'));
    await assert.rejects(main({ args: ['--once'], env: cliEnv }), /Unknown option/);
  });

test('first run generates server secrets and initializes without --init',
  { skip: process.platform === 'win32', timeout: 60000 }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'matrius-fresh-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const bin = join(dir, 'bin');
    const workspace = join(dir, 'remote');
    const dockerLog = join(dir, 'docker.log');
    const curlLog = join(dir, 'curl.log');
    await mkdir(bin); await mkdir(workspace);
    await writeFile(join(bin, 'docker'), '#!/usr/bin/env bash\n'
      + 'printf "%s\\n" "$*" >> "$DOCKER_TEST_LOG"\n'
      + 'if [[ " $* " == *" run "* ]]; then\n'
      + '  printf "run-admin=%s/%s\\n" "${INITIAL_ADMIN_USERNAME:-}" "${INITIAL_ADMIN_PASSWORD:-}" >> "$DOCKER_TEST_LOG"\n'
      + 'fi\n'
      + 'if [[ ${DOCKER_TEST_FRESH:-0} == 1 && " $* " == *" volume inspect "* ]]; then exit 1; fi\n');
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
    };

    await main({ args: [], env });
    const generated = await readFile(join(workspace, 'production.env'), 'utf8');
    assert.match(generated, /^POSTGRES_PASSWORD=[0-9a-f]{64}$/m);
    assert.match(generated, /^INITIAL_ADMIN_USERNAME=root$/m);
    assert.match(generated, /^INITIAL_ADMIN_PASSWORD=custom-admin-password$/m);
    assert.match(generated, /^APP_PORT=3000$/m);
    assert.match(generated, /^API_PORT=3001$/m);
    assert.match(generated, /^APP_HTTPS_PORT=3443$/m);
    assert.equal((await stat(join(workspace, 'production.env'))).mode & 0o777, 0o600);
    assert.match(await readFile(join(workspace, 'initial-admin.txt'), 'utf8'),
      /username=root\npassword=custom-admin-password/);
    const commands = await readFile(dockerLog, 'utf8');
    assert.match(commands, / build web api\n/);
    assert.match(commands, /up -d --wait --wait-timeout 180 postgres redis rustfs openserp\n/);
    assert.match(commands, /run -T --rm --no-deps migrate\n/);
    assert.match(commands, /run-admin=root\/custom-admin-password\n/);
    assert(!commands.includes('INITIAL_ADMIN_PASSWORD=custom-admin-password'));
    assert.match(commands, /up -d --no-deps web api\n/);

    // Later runs keep the generated file and skip initialization.
    await writeFile(dockerLog, '');
    await main({ args: [], env: { ...env, DOCKER_TEST_FRESH: '0' } });
    assert.equal(await readFile(join(workspace, 'production.env'), 'utf8'), generated);
    const later = await readFile(dockerLog, 'utf8');
    assert(!later.includes(' build '));
    assert(!later.includes('run -T --rm --no-deps migrate'));

    // A local port change rewrites only that key and survives the next deploy.
    await writeFile(dockerLog, '');
    await writeFile(curlLog, '');
    await main({ args: [], env: { ...env, DOCKER_TEST_FRESH: '0', APP_PORT: '4000' } });
    const updated = await readFile(join(workspace, 'production.env'), 'utf8');
    assert.match(updated, /^APP_PORT=4000$/m);
    assert.match(updated, /^API_PORT=3001$/m);
    assert.match(updated, /^POSTGRES_PASSWORD=[0-9a-f]{64}$/m);
    assert.match(updated, /^INITIAL_ADMIN_PASSWORD=custom-admin-password$/m);
    assert.equal((await stat(join(workspace, 'production.env'))).mode & 0o777, 0o600);
    assert.match(await readFile(curlLog, 'utf8'), /:4000\/api\/health/);
  });
