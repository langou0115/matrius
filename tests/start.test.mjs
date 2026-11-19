import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildFrontend, resolveStartConfig } from '../scripts/start.mjs';

test('resolveStartConfig reads API_PORT, HOST, DATA_DIR and AUTH_SECRET from .env.local with env override', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'matrius-start-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const emptyConfig = await resolveStartConfig({ root, env: {} });
  assert.deepEqual(emptyConfig, {
    apiPort: 8000,
    host: '0.0.0.0',
    dataDir: join(homedir(), '.matrius'),
    authEnabled: false,
  });

  await writeFile(
    join(root, '.env.local'),
    'WEB_PORT=8088\nAPI_PORT=8008\nHOST=127.0.0.1\nAUTH_SECRET=my-secret\n',
  );
  const fromFile = await resolveStartConfig({ root, env: {} });
  assert.equal(fromFile.apiPort, 8008);
  assert.equal(fromFile.host, '127.0.0.1');
  assert.equal(fromFile.authEnabled, true);

  const overridden = await resolveStartConfig({ root, env: { API_PORT: '9001', AUTH_SECRET: '' } });
  assert.equal(overridden.apiPort, 9001);
  assert.equal(overridden.authEnabled, false);

  await assert.rejects(() => resolveStartConfig({ root, env: { API_PORT: 'abc' } }), /Invalid API_PORT/);
});

test('buildFrontend runs a full build on every call and verifies dist/index.html exists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'matrius-start-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    () => buildFrontend({ root, runBuild: async () => {} }),
    /without producing dist\/index\.html/,
  );

  let builds = 0;
  const runBuild = async () => {
    builds += 1;
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'index.html'), `<!doctype html><!-- ${builds} -->`);
  };

  await buildFrontend({ root, runBuild });
  await buildFrontend({ root, runBuild });
  assert.equal(builds, 2);
});
