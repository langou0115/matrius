import { invalid } from '../errors';

export const CLIENT_ID_RE = /^[^\s\x00-\x1f\x7f]{1,128}$/u;

/** Trim and validate the client-generated id used for idempotent writes. */
export function validateClientId(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!CLIENT_ID_RE.test(trimmed)) {
    throw invalid('clientId 必须是 1–128 个不含空白或控制字符的字符。');
  }
  return trimmed;
}

/** Match the old `clamp_page_size` helper: reject < 1, cap at 100. */
export function clampPageSize(limit: number, maximum = 100): number {
  if (!Number.isInteger(limit) || limit < 1) throw invalid('limit 必须大于 0。');
  return Math.min(limit, maximum);
}

export function parsePositiveInt(value: string, message = '分页游标无效。'): number {
  if (!/^\d+$/u.test(value)) throw invalid(message);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw invalid(message);
  return parsed;
}
