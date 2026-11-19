import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  buildAuthCookieHeader,
  buildClearAuthCookieHeader,
  isAuthorizedCookie,
  isHttpsRequest,
  verifyAuthSecret,
} from '../auth/secret-gate';
import type { Settings } from '../config';
import { AppError } from '../errors';
import type { MemoryCache } from '../services/cache';

const unlockSchema = z.object({
  secret: z.string().min(1, '请输入访问密钥。').max(1_000),
});

export type AuthRouteDeps = {
  settings: Settings;
  cache: MemoryCache;
};

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { settings, cache } = deps;

  app.get('/api/auth/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      required: settings.authEnabled,
      unlocked: !settings.authEnabled || isAuthorizedCookie(request.headers.cookie, settings.AUTH_SECRET),
    };
  });

  app.post('/api/auth/unlock', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    cache.enforceRateLimit('auth_unlock', request.ip || 'unknown', 10, 60);
    const payload = unlockSchema.parse(request.body ?? {});
    if (!settings.authEnabled) {
      return { ok: true, unlocked: true };
    }
    if (!verifyAuthSecret(payload.secret, settings.AUTH_SECRET)) {
      throw new AppError(401, 'invalid_secret', '访问密钥不正确。');
    }
    const secure = isHttpsRequest(request.headers, (request.raw.socket as { encrypted?: boolean }).encrypted);
    reply.header('Set-Cookie', buildAuthCookieHeader(settings.AUTH_SECRET, settings.AUTH_SESSION_TTL_SECONDS, secure));
    return { ok: true, unlocked: true };
  });

  app.post('/api/auth/lock', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const secure = isHttpsRequest(request.headers, (request.raw.socket as { encrypted?: boolean }).encrypted);
    reply.header('Set-Cookie', buildClearAuthCookieHeader(secure));
    return { ok: true };
  });
}
