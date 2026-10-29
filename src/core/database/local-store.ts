import * as SQLite from 'expo-sqlite';

import type { WorkspaceData } from '@/features/workspace/workspace-schema';

/** Mirrors the web store's conflict error, so shared callers can retry or explain it. */
export class LocalDataConflict extends Error {
  constructor() { super('Local data changed in another session'); }
}

type StoredValue = { revision: number; value: unknown };
type Row = { revision: number; value: string };

let connection: Promise<SQLite.SQLiteDatabase> | undefined;

function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (connection) return connection;
  const pending = SQLite.openDatabaseAsync('matrius.db').then(async (database) => {
    await database.execAsync(
      'PRAGMA journal_mode = WAL;'
      + 'CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL);',
    );
    return database;
  });
  connection = pending;
  void pending.catch(() => { if (connection === pending) connection = undefined; });
  return pending;
}

export async function readLocalValue(key: string): Promise<StoredValue | null> {
  const database = await openDatabase();
  const row = await database.getFirstAsync<Row>('SELECT revision, value FROM kv WHERE key = ?', key);
  if (!row) return null;
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Invalid local database record');
  return { revision: row.revision, value: JSON.parse(row.value) as unknown };
}

export async function writeLocalValue(key: string, value: unknown, expectedRevision: number): Promise<number> {
  const database = await openDatabase();
  // Serialize before opening the transaction: a circular value must not leave a write lock.
  const encoded = JSON.stringify(value);
  let conflict = false;
  try {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const row = await transaction.getFirstAsync<{ revision: number }>('SELECT revision FROM kv WHERE key = ?', key);
      const current = row?.revision ?? 0;
      if (current !== expectedRevision) {
        conflict = true;
        throw new LocalDataConflict();
      }
      await transaction.runAsync(
        'INSERT INTO kv (key, revision, value) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, value = excluded.value',
        key, expectedRevision + 1, encoded,
      );
    });
  } catch (reason) {
    if (conflict) throw new LocalDataConflict();
    throw reason;
  }
  return expectedRevision + 1;
}

const WORKSPACE_KEY = 'workspace';

/** The native first version stores the whole workspace as one record. Message bodies are
    already stripped of image bytes by the persistence layer, so a record stays small. */
export async function readWorkspace(): Promise<StoredValue | null> {
  return readLocalValue(WORKSPACE_KEY);
}

export function writeWorkspace(value: WorkspaceData, expectedRevision: number): Promise<number> {
  return writeLocalValue(WORKSPACE_KEY, value, expectedRevision);
}
