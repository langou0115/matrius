import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let dockerAvailable = true;
try { await execute('docker', ['compose', 'version']); } catch { dockerAvailable = false; }

for (const custom of [false, true]) {
  test(`Compose ${custom ? 'custom' : 'default'} service ports agree across commands, clients, health checks and discovery`, { skip: !dockerAvailable }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'matrius-compose-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const envFile = join(directory, 'test.env');
    await writeFile(envFile, '');
    const ports = custom ? [15432, 16379, 19000, 17000] : [5432, 6379, 9000, 7000];
    const names = ['POSTGRES_PORT', 'REDIS_PORT', 'RUSTFS_PORT', 'OPENSERP_PORT'];
    const env = { ...process.env, POSTGRES_PASSWORD: 'fixture', REDIS_PASSWORD: 'fixture',
      RUSTFS_ACCESS_KEY: 'fixture', RUSTFS_SECRET_KEY: 'fixture',
      ...Object.fromEntries(names.map((name, index) => [name, custom ? String(ports[index]) : ''])) };
    const { stdout } = await execute('docker', ['compose', '--project-directory', join(root, 'docker-compose'),
      '--env-file', envFile, '-f', join(root, 'docker-compose/docker-compose.yml'), 'config', '--format', 'json'], { env });
    const { services } = JSON.parse(stdout);
    for (const [index, name] of ['postgres', 'redis', 'rustfs', 'openserp'].entries()) {
      assert.equal(services[name].labels['io.matrius.dev.port'], String(ports[index]));
      assert(!services[name].ports?.length, `${name} must not publish host ports`);
      assert(services[name].healthcheck.test.join(' ').includes(String(ports[index])), `${name} health check port`);
    }
    assert.deepEqual(services.postgres.command, ['postgres', '-p', String(ports[0])]);
    assert.equal(services.redis.command[services.redis.command.indexOf('--port') + 1], String(ports[1]));
    assert.equal(services.rustfs.environment.RUSTFS_ADDRESS, `0.0.0.0:${ports[2]}`);
    assert.equal(services.openserp.command.at(-1), String(ports[3]));
    assert(services.api.environment.DATABASE_URL.includes(`@postgres:${ports[0]}/`));
    assert.equal(services.migrate.environment.DATABASE_URL, services.api.environment.DATABASE_URL);
    assert(services.api.environment.REDIS_URL.includes(`@redis:${ports[1]}/`));
    assert.equal(services.api.environment.RUSTFS_ENDPOINT, `http://rustfs:${ports[2]}`);
    assert.equal(services.api.environment.OPENSERP_URL, `http://openserp:${ports[3]}`);
  });
}
