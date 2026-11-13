/**
 * SQLite storage codecs.
 *
 * The Python server stored:
 *   - UUIDs as 32-char lowercase hex strings (SQLAlchemy `Uuid` on SQLite);
 *   - timestamps as `YYYY-MM-DD HH:MM:SS.ffffff` in UTC without a timezone suffix;
 *   - nullable JSON columns as the literal string `null`;
 *   - booleans as 0/1.
 *
 * Every database read/write must go through these helpers. Changing them without
 * a data migration will make existing rows unreadable or mis-sorted.
 */

const UUID_HEX = /^[0-9a-f]{32}$/u;
const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function toDbUuid(value: string): string {
  const hex = value.trim().replaceAll('-', '').toLowerCase();
  if (!UUID_HEX.test(hex)) throw new Error(`Invalid UUID: ${value}`);
  return hex;
}

export function fromDbUuid(value: string): string {
  const hex = value.trim().toLowerCase();
  if (!UUID_HEX.test(hex)) throw new Error(`Invalid stored UUID: ${value}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isCanonicalUuid(value: string): boolean {
  return UUID_CANONICAL.test(value);
}

/** Format a Date exactly like SQLAlchemy's SQLite DATETIME column. */
export function toDbTimestamp(value: Date = new Date()): string {
  if (Number.isNaN(value.getTime())) throw new Error('Invalid date');
  // toISOString() has three fractional digits; appending 000 keeps the six-digit shape.
  return value.toISOString().replace('T', ' ').replace(/Z$/u, '000');
}

/** Parse a naive-UTC SQLite DATETIME value into an aware Date. */
export function fromDbTimestamp(value: string): Date {
  const text = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/u.test(text)) return new Date(text);
  return new Date(`${text.replace(' ', 'T')}Z`);
}

/** Epoch milliseconds for API responses. */
export function toMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === 'string' ? fromDbTimestamp(value) : value;
  return Number.isNaN(date.getTime()) ? null : Math.round(date.getTime());
}

export function toDbDate(value: Date = new Date()): string {
  if (Number.isNaN(value.getTime())) throw new Error('Invalid date');
  return value.toISOString().slice(0, 10);
}

/** JSON columns store `null` as text, matching SQLAlchemy's JSON bind processor. */
export function toDbJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromDbJson<T>(value: string | null | undefined): T | null {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function toDbBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromDbBool(value: number | bigint | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return Number(value) !== 0;
}

export function toDbInt(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer: ${value}`);
  return value;
}

export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
