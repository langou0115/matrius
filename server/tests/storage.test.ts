import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LocalStorage, diskUsage } from '../services/storage';

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

test('disk usage is reported for the data filesystem', () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-storage-'));
  try {
    const usage = diskUsage(directory);
    assert.ok(usage.total > 0);
    assert.ok(usage.free >= 0);
    assert.equal(usage.used, usage.total - usage.free);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
