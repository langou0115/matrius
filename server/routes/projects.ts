import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import {
  createWorkProjectRow,
  deleteWorkProjectRow,
  listWorkProjectRows,
  serializeWorkProject,
} from '../db/repositories/projects';

const INSTANCE_ID = 1;

const createProjectSchema = z.object({
  hostId: z.string().min(1).max(120),
  directory: z.string().min(1).max(1000),
  name: z.string().max(120).optional(),
});

const deleteProjectQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1).optional(),
});

export type ProjectRouteDeps = {
  db: AppDatabase;
};

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const { db } = deps;

  app.get('/api/projects', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const items = listWorkProjectRows(db, INSTANCE_ID).map(serializeWorkProject);
    return { items };
  });

  app.post('/api/projects', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = createProjectSchema.parse(request.body ?? {});
    const created = db.transaction(() => serializeWorkProject(createWorkProjectRow(db, INSTANCE_ID, body)));
    reply.code(201);
    return created;
  });

  app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
    const query = deleteProjectQuerySchema.parse(request.query ?? {});
    db.transaction(() => deleteWorkProjectRow(db, INSTANCE_ID, request.params.projectId, query.baseRevision));
    reply.code(204);
  });
}
