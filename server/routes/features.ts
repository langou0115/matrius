import type { FastifyInstance } from 'fastify';

import type { Settings } from '../config';
import { enabledFeatures } from '../features/registry';

/**
 * Public capability list used by the UI on startup.
 *
 * The response must never be cached: a deployment can add a feature and the
 * open page should see it after a refresh, not after a cache expiry.
 */
export function registerFeatureRoutes(app: FastifyInstance, settings: Pick<Settings, 'authEnabled' | 'MATRIUS_DESKTOP_DEV'>): void {
  app.get('/api/features', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (settings.authEnabled) reply.header('X-Matrius-Auth', 'required');
    return { features: enabledFeatures().filter(({ id }) =>
      (id !== 'desktop-chat-settings' && id !== 'work-file-search') || settings.MATRIUS_DESKTOP_DEV) };
  });
}
