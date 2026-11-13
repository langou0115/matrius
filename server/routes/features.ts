import type { FastifyInstance } from 'fastify';

import { enabledFeatures } from '../features/registry';

/**
 * Public capability list used by the UI on startup.
 *
 * The response must never be cached: a deployment can add a feature and the
 * open page should see it after a refresh, not after a cache expiry.
 */
export function registerFeatureRoutes(app: FastifyInstance): void {
  app.get('/api/features', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { features: enabledFeatures() };
  });
}
