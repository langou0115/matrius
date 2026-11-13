import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppDatabase } from './client';

export type Migration = {
  readonly id: string;
  readonly file: string;
};

/**
 * Revision IDs intentionally match the Alembic revision IDs.
 *
 * The first TypeScript release is schema-neutral: an existing database recorded
 * at `0001_initial` is adopted, not rebuilt. Future migrations must keep the same
 * `alembic_version` table so a Python rollback and existing backups still work.
 */
export const MIGRATIONS: readonly Migration[] = [
  { id: '0001_initial', file: '0001_initial.sql' },
];

export const HEAD_REVISION = MIGRATIONS[MIGRATIONS.length - 1].id;

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export type MigrationResult = {
  from: string | null;
  to: string;
  applied: string[];
};

export function ensureVersionTable(db: AppDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alembic_version (
      version_num VARCHAR(32) NOT NULL,
      CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
    );
  `);
}

export function currentRevision(db: AppDatabase): string | null {
  const row = db.prepare('SELECT version_num FROM alembic_version LIMIT 1').get() as
    | { version_num: string }
    | undefined;
  return row?.version_num ?? null;
}

function setRevision(db: AppDatabase, revision: string): void {
  db.prepare('DELETE FROM alembic_version').run();
  db.prepare('INSERT INTO alembic_version (version_num) VALUES (?)').run(revision);
}

export function ensureInstance(db: AppDatabase): void {
  db.prepare('INSERT OR IGNORE INTO instance (id) VALUES (1)').run();
}

function migrationSql(migration: Migration): string {
  return readFileSync(resolve(MIGRATIONS_DIR, migration.file), 'utf8');
}

function applyMigration(db: AppDatabase, migration: Migration): void {
  const sql = migrationSql(migration);
  db.transaction(() => {
    db.exec(sql);
    setRevision(db, migration.id);
  });
}

function hasUserTables(db: AppDatabase): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'alembic_version'`,
    )
    .get() as { count: number };
  return Number(row.count) > 0;
}

/**
 * Apply every migration after the recorded revision.
 *
 * A fresh database gets the full baseline. A database with user tables but no
 * version row is rejected instead of guessed at: stamp it explicitly or restore a
 * backup. This keeps an old unversioned database from being silently treated as
 * current.
 */
export function migrate(db: AppDatabase): MigrationResult {
  ensureVersionTable(db);
  let current = currentRevision(db);
  const from = current;
  const applied: string[] = [];

  if (!current) {
    if (hasUserTables(db)) {
      throw new Error(
        'Database has tables but no alembic_version row. Restore a backup or stamp 0001_initial explicitly before starting.',
      );
    }
    applyMigration(db, MIGRATIONS[0]);
    applied.push(MIGRATIONS[0].id);
    current = MIGRATIONS[0].id;
  }

  const index = MIGRATIONS.findIndex((migration) => migration.id === current);
  if (index < 0) {
    throw new Error(`Database revision ${current} is not known to this build (head ${HEAD_REVISION}).`);
  }

  for (const migration of MIGRATIONS.slice(index + 1)) {
    applyMigration(db, migration);
    applied.push(migration.id);
    current = migration.id;
  }

  ensureInstance(db);
  return { from, to: current, applied };
}

export type SchemaStatus = {
  ok: boolean;
  current: string | null;
  expected: string;
};

export function schemaStatus(db: AppDatabase): SchemaStatus {
  const current = currentRevision(db);
  return { ok: current === HEAD_REVISION, current, expected: HEAD_REVISION };
}

export function assertSchemaHead(db: AppDatabase): void {
  const status = schemaStatus(db);
  if (!status.ok) {
    throw new Error(`Database at ${status.current ?? 'unversioned'}, application expects ${status.expected}.`);
  }
}
