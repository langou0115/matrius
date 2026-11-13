import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type DatabaseOptions = {
  busyTimeoutMs?: number;
  readOnly?: boolean;
};

/**
 * Thin synchronous SQLite wrapper.
 *
 * `node:sqlite` is part of Node 24 and keeps the server dependency-free. Keep
 * transactions synchronous: awaiting inside a transaction would let unrelated
 * requests share the connection's write lock.
 */
export class AppDatabase {
  readonly raw: DatabaseSync;
  readonly path: string;
  private depth = 0;

  constructor(path: string, options: DatabaseOptions = {}) {
    this.path = path;
    if (!options.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      readOnly: options.readOnly ?? false,
      timeout: options.busyTimeoutMs ?? 0,
    });
    if (!options.readOnly) {
      this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  get isTransaction(): boolean {
    return this.depth > 0;
  }

  /** Run `fn` atomically, using a savepoint when a transaction is already open. */
  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `matrius_sp_${this.depth}`;
    this.raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const value = fn();
      this.raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      try {
        this.raw.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      } catch {
        // A failed rollback must not hide the original error.
      }
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function openDatabase(path: string, options: DatabaseOptions = {}): AppDatabase {
  return new AppDatabase(path, options);
}
