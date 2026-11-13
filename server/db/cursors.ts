import { invalid } from '../errors';

/**
 * Opaque keyset cursors, byte-compatible with the Python server's
 * `base64.urlsafe_b64encode("|".join(parts)).rstrip("=")`.
 */
export function encodeCursor(...parts: string[]): string {
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}

export function decodeCursor(value: string, expectedParts: number): string[] {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw invalid('分页游标无效。');
  const raw = Buffer.from(value, 'base64url').toString('utf8');
  const parts = raw.split('|');
  if (parts.length !== expectedParts) throw invalid('分页游标无效。');
  return parts;
}

/**
 * Convert an ISO cursor timestamp back to the six-digit SQLite shape without
 * going through `Date`, which would drop microseconds and can skip rows whose
 * timestamps differ only below the millisecond.
 */
export function parseDbTimestampCursor(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)?$/u.exec(raw);
  if (!match) throw invalid('分页游标无效。');
  return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`;
}

/** Format a stored timestamp as a Python-compatible ISO cursor value. */
export function formatDbTimestampCursor(value: string): string {
  return `${value.replace(' ', 'T')}+00:00`;
}
