import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openDatabase } from '../db/client';
import {
  HEAD_REVISION,
  currentRevision,
  ensureVersionTable,
  migrate,
  schemaStatus,
} from '../db/migrate';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'matrius-migrate-'));
}

test('a fresh database gets the baseline and the singleton instance', () => {
  const directory = temporaryDirectory();
  const db = openDatabase(join(directory, 'fresh.db'), { busyTimeoutMs: 1000 });
  try {
    const result = migrate(db);
    assert.equal(result.from, null);
    assert.equal(result.to, HEAD_REVISION);
    assert.deepEqual(result.applied, [HEAD_REVISION]);
    assert.equal(currentRevision(db), HEAD_REVISION);
    assert.deepEqual(schemaStatus(db), { ok: true, current: HEAD_REVISION, expected: HEAD_REVISION });
    const instance = db.prepare('SELECT id FROM instance').get() as { id: number } | undefined;
    assert.equal(instance?.id, 1);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    for (const table of ['conversations', 'messages', 'files', 'profiles', 'preferences', 'token_usage_daily']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }

    const second = migrate(db);
    assert.deepEqual(second.applied, []);
    assert.equal(second.to, HEAD_REVISION);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an existing database at the baseline is adopted without rebuilding', () => {
  const directory = temporaryDirectory();
  const path = join(directory, 'existing.db');
  const first = openDatabase(path, { busyTimeoutMs: 1000 });
  try {
    migrate(first);
    first.prepare(
      `INSERT INTO conversations
       (id, instance_id, title, pinned, completed_state, error_state, updated_at, revision, created_at)
       VALUES (?, 1, ?, 0, 'absent', 'absent', ?, 1, ?)`,
    ).run('a96a3f0a8f13472ca16ca4d18dbded88', 'kept', '2026-11-12 02:28:01.710000', '2026-11-12 02:28:01.710000');
  } finally {
    first.close();
  }

  const reopened = openDatabase(path, { busyTimeoutMs: 1000 });
  try {
    const result = migrate(reopened);
    assert.deepEqual(result.applied, []);
    assert.equal(result.to, HEAD_REVISION);
    const row = reopened.prepare('SELECT title FROM conversations').get() as { title: string } | undefined;
    assert.equal(row?.title, 'kept');
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an unknown revision fails loudly instead of guessing', () => {
  const directory = temporaryDirectory();
  const db = openDatabase(join(directory, 'unknown.db'), { busyTimeoutMs: 1000 });
  try {
    migrate(db);
    db.prepare('DELETE FROM alembic_version').run();
    db.prepare('INSERT INTO alembic_version (version_num) VALUES (?)').run('9999_future');
    assert.throws(() => migrate(db), /not known to this build/u);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('tables without a version row are rejected', () => {
  const directory = temporaryDirectory();
  const db = openDatabase(join(directory, 'unversioned.db'), { busyTimeoutMs: 1000 });
  try {
    ensureVersionTable(db);
    db.exec('CREATE TABLE instance (id INTEGER PRIMARY KEY)');
    assert.throws(() => migrate(db), /no alembic_version row/u);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
