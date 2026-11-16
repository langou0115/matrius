import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    assert.deepEqual(result.applied, ['0001_initial', '0002_ui_workshop', '0003_ui_component_mode']);
    assert.equal(currentRevision(db), HEAD_REVISION);
    assert.deepEqual(schemaStatus(db), { ok: true, current: HEAD_REVISION, expected: HEAD_REVISION });
    const instance = db.prepare('SELECT id FROM instance').get() as { id: number } | undefined;
    assert.equal(instance?.id, 1);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    for (const table of ['conversations', 'messages', 'files', 'profiles', 'preferences', 'token_usage_daily',
      'ui_components', 'ui_component_versions', 'ui_component_bindings', 'ui_binding_commands']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
    const messageColumns = (db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    assert.ok(messageColumns.includes('ui_components'));
    const conversationColumns = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    assert.ok(conversationColumns.includes('kind'));
    const componentColumns = (db.prepare('PRAGMA table_info(ui_components)').all() as Array<{ name: string }>)
      .map((row) => row.name);
    assert.ok(componentColumns.includes('stateful'));

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

test('the workshop migration upgrades a populated database in place', () => {
  const directory = temporaryDirectory();
  const db = openDatabase(join(directory, 'upgrade.db'), { busyTimeoutMs: 1000 });
  try {
    ensureVersionTable(db);
    db.exec(readFileSync(new URL('../db/migrations/0001_initial.sql', import.meta.url), 'utf8'));
    db.prepare("INSERT INTO alembic_version (version_num) VALUES ('0001_initial')").run();
    db.prepare('INSERT INTO instance (id) VALUES (1)').run();
    const conversationId = 'a96a3f0a8f13472ca16ca4d18dbded88';
    db.prepare(
      `INSERT INTO conversations
       (id, instance_id, title, pinned, completed_state, error_state, updated_at, revision, created_at)
       VALUES (?, 1, ?, 0, 'absent', 'absent', ?, 1, ?)`,
    ).run(conversationId, 'kept', '2026-11-12 02:28:01.710000', '2026-11-12 02:28:01.710000');
    db.prepare(
      `INSERT INTO messages
       (id, instance_id, conversation_id, position, role, content, steering, status, file_ids, created_at, updated_at, revision)
       VALUES (?, 1, ?, 1, 'user', 'hello', 0, 'complete', '[]', ?, ?, 1)`,
    ).run('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', conversationId, '2026-11-12 02:28:01.710000', '2026-11-12 02:28:01.710000');

    const result = migrate(db);
    assert.deepEqual(result.applied, ['0002_ui_workshop', '0003_ui_component_mode']);
    assert.equal(result.to, HEAD_REVISION);
    assert.equal(result.from, '0001_initial');

    const conversation = db.prepare('SELECT title, kind FROM conversations').get() as
      | { title: string; kind: string }
      | undefined;
    assert.equal(conversation?.title, 'kept');
    assert.equal(conversation?.kind, 'chat', 'existing conversations default to chat');
    const message = db.prepare('SELECT content, ui_components FROM messages').get() as
      | { content: string; ui_components: string | null }
      | undefined;
    assert.equal(message?.content, 'hello');
    assert.equal(message?.ui_components, null);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name);
    for (const table of ['ui_components', 'ui_component_versions', 'ui_component_bindings', 'ui_binding_commands']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the component-mode migration backfills stateful from version schemas', () => {
  const directory = temporaryDirectory();
  const db = openDatabase(join(directory, 'mode.db'), { busyTimeoutMs: 1000 });
  try {
    ensureVersionTable(db);
    db.exec(readFileSync(new URL('../db/migrations/0001_initial.sql', import.meta.url), 'utf8'));
    db.exec(readFileSync(new URL('../db/migrations/0002_ui_workshop.sql', import.meta.url), 'utf8'));
    db.prepare("INSERT INTO alembic_version (version_num) VALUES ('0002_ui_workshop')").run();
    db.prepare('INSERT INTO instance (id) VALUES (1)').run();
    const now = '2026-11-12 02:28:01.710000';
    const insertComponent = db.prepare(
      `INSERT INTO ui_components
       (id, instance_id, name, description, status, current_version, published_version, conversation_id, created_at, updated_at, revision)
       VALUES (?, 1, ?, '', 'draft', 1, NULL, NULL, ?, ?, 1)`,
    );
    const insertVersion = db.prepare(
      `INSERT INTO ui_component_versions
       (id, component_id, version, status, name, description, html, input_schema, state_schema, commands, events, protocol_version, created_at)
       VALUES (?, ?, 1, 'draft', ?, '', '<div></div>', '{}', ?, '[]', '[]', 1, ?)`,
    );
    const statefulId = 'cccccccccccccccccccccccccccccccc';
    const displayId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    insertComponent.run(statefulId, '棋盘', now, now);
    insertVersion.run('dddddddddddddddddddddddddddddddd', statefulId, '棋盘', JSON.stringify({ type: 'object' }), now);
    insertComponent.run(displayId, '看板', now, now);
    insertVersion.run('ffffffffffffffffffffffffffffffff', displayId, '看板', null, now);

    const result = migrate(db);
    assert.deepEqual(result.applied, ['0003_ui_component_mode']);
    assert.equal(result.to, HEAD_REVISION);
    const rows = db.prepare('SELECT id, stateful FROM ui_components ORDER BY id').all() as Array<{ id: string; stateful: number }>;
    const byId = new Map(rows.map((row) => [row.id, Number(row.stateful)]));
    assert.equal(byId.get(statefulId), 1, 'a component with a state schema stays stateful');
    assert.equal(byId.get(displayId), 0, 'a component without one stays display-only');
  } finally {
    db.close();
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
