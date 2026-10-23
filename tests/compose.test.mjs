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

test('Compose runs exactly caddy, web and api on one network with one data volume', { skip: !dockerAvailable }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-compose-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, 'test.env');
  await writeFile(envFile, 'APP_PORT=16666\nAPI_PORT=16667\nAPP_HTTPS_PORT=8443\n'
    + 'CADDY_SITE_ADDRESS=\nINITIAL_ADMIN_USERNAME=admin\nINITIAL_ADMIN_PASSWORD=fixture\n');
  const { stdout } = await execute('docker', ['compose', '--project-directory', join(root, 'docker-compose'),
    '--env-file', envFile, '-f', join(root, 'docker-compose/docker-compose.yml'), 'config', '--format', 'json']);
  const config = JSON.parse(stdout);
  assert.deepEqual(Object.keys(config.services).sort(), ['api', 'caddy', 'web']);
  for (const removed of ['migrate', 'postgres', 'redis', 'rustfs', 'openserp']) {
    assert.equal(config.services[removed], undefined, `${removed} must be removed`);
  }
  assert.deepEqual(Object.keys(config.networks), ['edge']);
  assert.equal(config.networks.edge.name, 'matrius_prod_edge');
  assert.deepEqual(Object.keys(config.volumes).sort(), ['api_data', 'caddy_config', 'caddy_data']);
  assert.equal(config.volumes.api_data.name, 'matrius_prod_api_data');

  const api = config.services.api;
  assert.equal(api.environment.DATABASE_URL, 'sqlite+aiosqlite:////data/matrius.db');
  assert.equal(api.environment.DATA_DIR, '/data');
  assert.deepEqual(api.volumes, [{ type: 'volume', source: 'api_data', target: '/data', volume: {} }]);
  assert.equal(api.depends_on, undefined);
  assert(api.healthcheck.start_period.endsWith('s'));
  for (const removed of ['POSTGRES_PASSWORD', 'REDIS_URL', 'RUSTFS_ENDPOINT', 'OPENSERP_URL']) {
    assert.equal(api.environment[removed], undefined, `${removed} must be gone`);
  }
  assert.equal(config.services.caddy.depends_on.api.condition, 'service_healthy');
  assert.equal(config.services.caddy.depends_on.web.condition, 'service_healthy');
});
