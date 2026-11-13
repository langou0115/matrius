import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { AppError } from '../errors';

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

  /** Disk capacity of the filesystem behind `DATA_DIR`. */
  diskUsage(): { total: number; used: number; free: number } {
    return diskUsage(this.root);
  }

  writeAppError(error: unknown): AppError {
    return new AppError(502, 'storage_error', '文件存储失败，请稍后重试。', { cause: error });
  }
}

export function diskUsage(path: string): { total: number; used: number; free: number } {
  const stats = statfsSync(path);
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bavail) * Number(stats.bsize);
  return { total, used: total - free, free };
}
