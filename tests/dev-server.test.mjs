import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { prepareServer, sourceSnapshot } from '../scripts/dev-server.mjs';

test('server cache tracks source edits, additions and deletions without scanning vendor data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'vendor'));
  await writeFile(join(directory, 'vendor', 'ignored.ts'), 'ignored');
  await writeFile(join(directory, 'entry.ts'), 'first');
  const initial = await sourceSnapshot(directory);
  assert.equal(initial.length, 1);
  await writeFile(join(directory, 'entry.ts'), 'changed source');
  const changed = await sourceSnapshot(directory);
  assert.notDeepEqual(changed, initial);
  await writeFile(join(directory, 'added.ts'), 'added');
  assert.equal((await sourceSnapshot(directory)).length, 2);
  await rm(join(directory, 'added.ts'));
  assert.deepEqual(await sourceSnapshot(directory), changed);
});

test('cached backend preserves migrations, debug assets and lazy document service', { timeout: 60000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-cached-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = await prepareServer();
  assert.equal(await prepareServer(), entry);
  const code = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const { buildApp } = await import(pathToFileURL(process.env.TEST_SERVER_ENTRY).href);
    const { app, deps } = await buildApp();
    try {
      assert.equal((await app.inject('/api/health/ready')).statusCode, 200);
      assert.equal((await app.inject('/debug')).statusCode, 200);
      assert.equal((await app.inject('/api/openapi.json')).statusCode, 200);
      const lists = await Promise.all([deps.documents.run(1, { operation: 'list' }), deps.documents.run(1, { operation: 'list' })]);
      assert.deepEqual(lists[0], lists[1]);
      const help = await deps.documents.run(1, { operation: 'help', format: 'pdf' });
      assert.ok(help);
    } finally { await app.close(); }
  `;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, APP_ENV: 'test', DATA_DIR: directory, DATABASE_URL: '',
      TEST_SERVER_ENTRY: entry, LOG_LEVEL: 'silent', ENABLE_DEBUG_PAGE: 'true', WEBTOOL_PROXY_URL: '' },
    windowsHide: true,
    timeout: 45000,
  });
});
