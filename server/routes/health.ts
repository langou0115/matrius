import type { FastifyInstance } from 'fastify';

import type { Settings } from '../config';
import type { AppDatabase } from '../db/client';
import { schemaStatus } from '../db/migrate';
import type { MemoryCache } from '../services/cache';
import type { LocalStorage } from '../services/storage';

export type HealthDependencies = {
  settings: Settings;
  db: AppDatabase;
  storage: LocalStorage;
  cache: MemoryCache;
};

function databaseCheck(db: AppDatabase): void {
  db.prepare('SELECT 1').get();
}

function schemaCheck(db: AppDatabase): void {
  const status = schemaStatus(db);
  if (!status.ok) {
    throw new Error(`database at ${status.current ?? 'unversioned'}, application expects ${status.expected}`);
  }
}

/**
 * `GET /api/health` is the deployment/container probe.
 * `GET /api/health/ready` reports every in-process check plus document engines.
 *
 * Document engines are optional: missing OfficeCLI or the LibreOffice kit only
 * disables document tools, so they are reported without failing readiness.
 */
export function registerHealthRoutes(app: FastifyInstance, deps: HealthDependencies): void {
  app.get('/api/health', async (_request, reply) => {
    try {
      databaseCheck(deps.db);
      schemaCheck(deps.db);
      return { service: 'matrius', status: 'ok' };
    } catch {
      reply.code(503);
      return { service: 'matrius', status: 'error' };
    }
  });

  app.get('/api/health/ready', async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = {
      database: 'error',
      schema: 'error',
      cache: 'ok',
      storage: 'error',
    };
    try {
      databaseCheck(deps.db);
      checks.database = 'ok';
    } catch {
      // Reported below.
    }
    try {
      schemaCheck(deps.db);
      checks.schema = 'ok';
    } catch {
      // Reported below.
    }
    try {
      deps.storage.check();
      checks.storage = 'ok';
    } catch {
      // Reported below.
    }

    const healthy = Object.values(checks).every((value) => value === 'ok');
    if (!healthy) reply.code(503);
    return {
      service: 'matrius',
      status: healthy ? 'ok' : 'degraded',
      checks,
      // Presence of the upstream proxy, not its URL. Useful when page reads fail and the
      // operator needs to know whether this process started with the proxy configured.
      webTools: {
        proxy: deps.settings.WEBTOOL_PROXY_URL ? 'configured' : 'direct',
        fetchTimeoutSeconds: deps.settings.FETCH_TIMEOUT_SECONDS,
        fetchMaxAttempts: deps.settings.FETCH_MAX_ATTEMPTS,
      },
      // Filled in by the document services when they land. Do not report "ok"
      // before the engines have actually been probed.
      documents: { status: 'pending' },
    };
  });
}
