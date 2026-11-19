import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const AUTH_COOKIE_NAME = 'matrius_auth';

const TOKEN_KEY_CONTEXT = 'matrius-auth-cookie-v1';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function signingKey(secret: string): Buffer {
  return createHmac('sha256', TOKEN_KEY_CONTEXT).update(secret, 'utf8').digest();
}

/** Compare candidate secret against configured `AUTH_SECRET` in constant time. */
export function verifyAuthSecret(candidate: string, expected: string): boolean {
  if (!expected) return false;
  return timingSafeEqual(sha256(candidate), sha256(expected));
}

/** Sign an expiry timestamp into an opaque `exp.hmac` cookie token. */
export function signAuthToken(secret: string, ttlSeconds: number, nowSec = Math.floor(Date.now() / 1000)): string {
  const expiresAt = nowSec + Math.max(60, Math.trunc(ttlSeconds));
  const signature = createHmac('sha256', signingKey(secret)).update(String(expiresAt)).digest('hex');
  return `${expiresAt}.${signature}`;
}

/** Verify the signed `exp.hmac` token and check expiration against `nowSec`. */
export function verifyAuthToken(
  token: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const rawExp = token.slice(0, dot);
  const rawSig = token.slice(dot + 1);
  if (!/^\d+$/u.test(rawExp) || !/^[0-9a-f]{64}$/u.test(rawSig)) return false;
  const expiresAt = Number(rawExp);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSec) return false;
  const expectedSig = createHmac('sha256', signingKey(secret)).update(rawExp).digest();
  const actualSig = Buffer.from(rawSig, 'hex');
  return actualSig.length === expectedSig.length && timingSafeEqual(actualSig, expectedSig);
}

/** Extract one named cookie value from the HTTP `Cookie` header. */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isAuthorizedCookie(cookieHeader: string | undefined, secret: string): boolean {
  if (!secret) return true;
  return verifyAuthToken(parseCookie(cookieHeader, AUTH_COOKIE_NAME), secret);
}

export function isHttpsRequest(headers: IncomingHttpHeaders, encrypted?: boolean): boolean {
  if (encrypted === true) return true;
  const forwarded = headers['x-forwarded-proto'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (!raw) return false;
  return raw.split(',')[0]?.trim().toLowerCase() === 'https';
}

export function buildAuthCookieHeader(secret: string, ttlSeconds: number, secure: boolean): string {
  const token = signAuthToken(secret, ttlSeconds);
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(60, Math.trunc(ttlSeconds))}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearAuthCookieHeader(secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
