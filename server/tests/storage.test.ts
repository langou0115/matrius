import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalStorage, assertStorageAvailable, storageUsage } from '../services/storage';

test('objects are written, read and deleted under the storage root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-storage-'));
  const storage = new LocalStorage(directory);
  try {
    storage.ensure();
    storage.put('file-id/report.docx', Buffer.from('hello'));
    assert.equal(storage.get('file-id/report.docx').toString(), 'hello');
    storage.delete('file-id/report.docx');
    assert.throws(() => storage.get('file-id/report.docx'), /ENOENT/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('object keys cannot escape the storage root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-storage-'));
  const storage = new LocalStorage(directory);
  try {
    for (const key of ['../escape', '/absolute', 'a/../../escape', 'a\\b', '', 'a//b']) {
      assert.throws(() => storage.target(key), /Invalid storage key|escapes/u, key);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the configured storage budget caps writes and reports the remaining space', () => {
  assert.deepEqual(storageUsage(10, 100), { total: 100, used: 10, free: 90 });
  assert.deepEqual(storageUsage(150, 100), { total: 100, used: 150, free: 0 });

  assert.doesNotThrow(() => assertStorageAvailable(10, 5, 20));
  assert.throws(() => assertStorageAvailable(15, 6, 20), { code: 'storage_full' });
  // Replacing an existing file only consumes the size difference.
  assert.doesNotThrow(() => assertStorageAvailable(15, 6, 20, 5));
});
