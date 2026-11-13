import { ZodError } from 'zod';

export type AppErrorOptions = {
  details?: unknown;
  headers?: Record<string, string>;
  cause?: unknown;
};

/**
 * Stable API error. The public shape remains:
 *   { "error": { "code": "...", "message": "...", "details"?: ... } }
 *
 * A dictionary `details` is merged into the `error` object for compatibility
 * with the Python server's `conflict` responses (`{ current: ... }`).
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(statusCode: number, code: string, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }
}

export function notFound(message = '资源不存在。'): AppError {
  return new AppError(404, 'not_found', message);
}

export function conflict(message: string, current?: unknown): AppError {
  return new AppError(409, 'conflict', message, {
    ...(current === undefined ? {} : { details: { current } }),
  });
}

export function invalid(message: string, details?: unknown): AppError {
  return new AppError(422, 'invalid', message, { details });
}

export function validationError(details: unknown): AppError {
  return new AppError(422, 'validation_error', '请求参数不合法。', { details });
}

export function rateLimited(retryAfterSeconds: number, message = '请求过于频繁，请稍后重试。'): AppError {
  return new AppError(429, 'rate_limited', message, {
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

export function zodDetails(error: ZodError): Array<{ type: string; loc: Array<string | number>; msg: string }> {
  return error.issues.slice(0, 20).map((issue) => ({
    type: issue.code,
    loc: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
    msg: issue.message,
  }));
}

export function errorBody(error: AppError): Record<string, unknown> {
  const body: Record<string, unknown> = {
    error: { code: error.code, message: error.message },
  };
  if (error.details !== undefined) {
    if (isPlainRecord(error.details)) Object.assign(body.error as Record<string, unknown>, error.details);
    else (body.error as Record<string, unknown>).details = error.details;
  }
  return body;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
