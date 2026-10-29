import assert from 'node:assert/strict';
import { test } from 'node:test';

import { previewFileRequest } from '../src/features/files/mock-library.ts';

const list = (params = '') => previewFileRequest(`/api/files?${params}`);

test('preview library paginates 500 generated files', async () => {
  const seen = new Set();
  let cursor = null;
  let pages = 0;
  do {
    const page = await list(`limit=50&sort=created&order=desc${cursor ? `&cursor=${cursor}` : ''}`);
    for (const item of page.items) {
      assert.equal(seen.has(item.id), false, 'pages must not repeat rows');
      seen.add(item.id);
    }
    pages += 1;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 500);
  assert.equal(pages, 10);
});

test('preview library filters by kind and reports usage', async () => {
  const images = await list('kind=image&limit=200');
  const files = await list('kind=file&limit=200');
  assert.equal(images.items.length, 125);
  assert.equal(files.items.length, 200, 'the first file page is capped by limit');
  assert.ok(images.items.every((item) => item.contentType.startsWith('image/')));
  assert.ok(images.items.every((item) => item.previewUrl?.startsWith('data:image/svg+xml')));
  assert.ok(files.items.every((item) => !item.contentType.startsWith('image/')));

  const usage = await previewFileRequest('/api/files/usage');
  assert.equal(usage.images.count, 125);
  assert.equal(usage.files.count, 375);
  assert.equal(usage.images.bytes + usage.files.bytes, usage.used);
  assert.ok(usage.quota > usage.used);
});

test('preview library searches, sorts and mutates in memory', async () => {
  const results = await list('query=%E6%88%AA%E5%9B%BE&limit=200');
  assert.ok(results.items.length > 0);
  assert.ok(results.items.every((item) => item.filename.includes('截图')));

  const names = (await list('sort=name&order=asc&limit=200')).items.map((item) => item.filename);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')));

  const [first, second] = (await list('kind=file&limit=2')).items;
  const renamed = await previewFileRequest(`/api/files/${first.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ filename: '预览重命名.txt' }),
  });
  assert.equal(renamed.filename, '预览重命名.txt');
  assert.equal((await list('query=%E9%A2%84%E8%A7%88%E9%87%8D%E5%91%BD%E5%90%8D')).items.length, 1);

  const before = (await previewFileRequest('/api/files/usage')).files.count;
  const removed = await previewFileRequest('/api/files/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ ids: [first.id, second.id] }),
  });
  assert.equal(removed.deleted, 2);
  assert.equal((await previewFileRequest('/api/files/usage')).files.count, before - 2);
});
