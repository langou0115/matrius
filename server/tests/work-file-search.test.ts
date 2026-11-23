import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';

import { createWorkFileSearch } from '../services/work-file-search';

test('local file search matches names and paths and identifies files outside the project', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'matrius-file-search-'));
  const root = join(home, 'project');
  const local = join(root, 'frontend', 'index.ts');
  const external = join(home, 'documents', 'index.ts');
  await Promise.all([mkdir(join(root, 'frontend'), { recursive: true }), mkdir(join(home, 'documents'))]);
  await Promise.all([writeFile(local, ''), writeFile(external, '')]);
  const search = createWorkFileSearch({ home, platform: 'linux', listRoots: async () => [] });
  t.after(async () => {
    search.close();
    await rm(home, { recursive: true, force: true });
  });

  const signal = AbortSignal.timeout(3000);
  let result = await search.search('INDEX.TS', root, signal);
  while (result.indexing) {
    await setImmediate();
    result = await search.search('INDEX.TS', root, signal);
  }
  assert.deepEqual(new Set(result.items.map(({ path }) => path)), new Set([local, external]));
  assert.equal(result.items.find(({ path }) => path === local)?.localOutsideProject, undefined);
  assert.equal(result.items.find(({ path }) => path === external)?.localOutsideProject, true);
  assert.deepEqual((await search.search('frontend index', root, signal)).items.map(({ path }) => path), [local]);
  assert.deepEqual((await search.search(external, root, signal)).items.map(({ path }) => path), [external]);
});
