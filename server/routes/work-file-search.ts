import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { LOCAL_WORK_HOST_ID } from '../../contract/work-projects';
import type { AppDatabase } from '../db/client';
import { requireWorkProjectRow } from '../db/repositories/projects';
import { hasFeature } from '../features/registry';
import { resolveLocalTarget } from '../services/host-fs';
import { createWorkFileSearch } from '../services/work-file-search';

const querySchema = z.object({ q: z.string().trim().min(1).max(256) });

export function registerWorkFileSearch(app: FastifyInstance, db: AppDatabase, desktop: boolean): void {
  if (!desktop || !hasFeature('work-file-search')) return;
  const search = createWorkFileSearch();
  app.addHook('onClose', async () => search.close());
  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/file-search', async (request, reply) => {
    const { q } = querySchema.parse(request.query);
    const project = requireWorkProjectRow(db, 1, request.params.projectId);
    const root = project.host_id === LOCAL_WORK_HOST_ID
      ? await realpath(resolveLocalTarget(project.directory, homedir(), process.platform)).catch(() => undefined)
      : undefined;
    reply.header('Cache-Control', 'no-store');
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.once('close', abort);
    try {
      return await search.search(q, root, controller.signal);
    } finally {
      reply.raw.off('close', abort);
    }
  });
}
