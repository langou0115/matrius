import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import {
  createWorkProjectRow,
  deleteWorkProjectRow,
  listWorkProjectRows,
  serializeWorkProject,
  updateWorkProjectRow,
} from '../db/repositories/projects';
import type { WorkCliSessionService } from '../services/cli-sessions';
import type { WorkTerminalService } from '../services/terminals';

const INSTANCE_ID = 1;

const cliProxiesSchema = z.object({
  codex: z.string().max(500).optional(),
  antigravity: z.string().max(500).optional(),
  claude: z.string().max(500).optional(),
});

const createProjectSchema = z.object({
  hostId: z.string().min(1).max(120),
  directory: z.string().min(1).max(1000),
  name: z.string().max(120).optional(),
  cliProxies: cliProxiesSchema.optional(),
  proxyUrl: z.string().max(500).optional(),
});

const updateProjectSchema = z.object({
  hostId: z.string().min(1).max(120).optional(),
  directory: z.string().min(1).max(1000).optional(),
  name: z.string().max(120).optional(),
  cliProxies: cliProxiesSchema.optional(),
  proxyUrl: z.string().max(500).optional(),
  baseRevision: z.number().int().min(1).optional(),
});

const deleteProjectQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1).optional(),
});

const listCliSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export type ProjectRouteDeps = {
  db: AppDatabase;
  terminals?: WorkTerminalService;
  cliSessions?: WorkCliSessionService;
};

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const { db, terminals, cliSessions } = deps;

  app.get('/api/projects', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const items = listWorkProjectRows(db, INSTANCE_ID).map(serializeWorkProject);
    return { items };
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/cli-sessions', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = listCliSessionsQuerySchema.parse(request.query ?? {});
    if (!cliSessions) {
      return {
        projectId: request.params.projectId,
        items: [],
        total: 0,
        hasMore: false,
      };
    }
    return cliSessions.listByProject(request.params.projectId, { limit: query.limit });
  });

  app.post('/api/projects', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = createProjectSchema.parse(request.body ?? {});
    const created = db.transaction(() => serializeWorkProject(createWorkProjectRow(db, INSTANCE_ID, body)));
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = updateProjectSchema.parse(request.body ?? {});
    const updated = db.transaction(() => serializeWorkProject(updateWorkProjectRow(db, INSTANCE_ID, request.params.projectId, body)));
    return updated;
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const query = deleteProjectQuerySchema.parse(request.query ?? {});
    db.transaction(() => deleteWorkProjectRow(db, INSTANCE_ID, request.params.projectId, query.baseRevision));
    terminals?.removeByProject(request.params.projectId);
    reply.code(204);
  });
}
