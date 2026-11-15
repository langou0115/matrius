import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AppError } from '../errors';

export type StorageUsage = { total: number; used: number; free: number };

function formatStorageSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes} B`;
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

/**
 * The configured application storage budget. `used` is the sum of stored file
 * bytes; `total` comes from STORAGE_LIMIT_BYTES, never from the host filesystem.
 */
export function storageUsage(used: number, limit: number): StorageUsage {
  const total = Math.max(0, Math.trunc(limit));
  const usedBytes = Math.max(0, Math.trunc(used));
  return { total, used: usedBytes, free: Math.max(0, total - usedBytes) };
}

/** Reject a write that would exceed the configured storage budget. */
export function assertStorageAvailable(
  used: number,
  incoming: number,
  limit: number,
  replaced = 0,
): void {
  if (used - replaced + incoming <= limit) return;
  throw new AppError(
    413,
    'storage_full',
    `存储空间不足，上限为 ${formatStorageSize(limit)}。`,
  );
}

/**
 * Filesystem object storage rooted at `DATA_DIR/files`.
 *
 * Object keys are relative POSIX paths (`<fileId>/<filename>`). They are
 * validated so a key cannot escape the storage root, and writes use a temporary
 * file + rename so readers never observe a partial upload.
 */
export class LocalStorage {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, 'files');
  }

  ensure(): string {
    mkdirSync(this.root, { recursive: true });
    return this.root;
  }

  check(): void {
    this.ensure();
    const directory = mkdtempSync(join(this.root, '.check-'));
    rmSync(directory, { recursive: true, force: true });
  }

  target(key: string): string {
    if (!key || key.includes('\0') || key.includes('\\')) throw new Error('Invalid storage key');
    const parts = key.split('/');
    if (key.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
      throw new Error('Invalid storage key');
    }
    const target = resolve(this.root, key);
    const rel = relative(this.root, target);
    if (rel === '' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('Storage key escapes the data directory');
    }
    return target;
  }

  put(key: string, data: Uint8Array): void {
    const target = this.target(key);
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.upload-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(temporary, data);
      renameSync(temporary, target);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Best effort cleanup.
      }
      throw error;
    }
  }

  get(key: string): Buffer {
    return readFileSync(this.target(key));
  }

  delete(key: string): void {
    try {
      unlinkSync(this.target(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  temporaryDirectory(prefix = 'matrius-'): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  writeAppError(error: unknown): AppError {
    return new AppError(502, 'storage_error', '文件存储失败，请稍后重试。', { cause: error });
  }
}
