import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { createHostFsService, type HostFsService } from '../services/host-fs';
import { createWorkHostService, type WorkHostService } from '../services/hosts';

const hostKindSchema = z.enum(['ssh', 'wsl']);
const authMethodSchema = z.enum(['agent', 'key', 'password']);

const createHostSchema = z.object({
  kind: hostKindSchema,
  name: z.string().max(120),
  host: z.string().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65_535).optional(),
  username: z.string().max(120).optional(),
  authMethod: authMethodSchema.optional(),
  privateKeyPath: z.string().max(500).optional(),
  secret: z.string().max(10_000).optional(),
  distro: z.string().max(120).optional(),
  defaultDirectory: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
});

const patchHostSchema = createHostSchema.extend({
  baseRevision: z.number().int().min(1),
  clearSecret: z.boolean().optional(),
});

const deleteHostQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1).optional(),
});

const fsQuerySchema = z.object({
  path: z.string().max(1000).optional(),
});

const fsBrowseQuerySchema = fsQuerySchema.extend({
  refresh: z.enum(['0', '1', 'true', 'false']).optional(),
});

const unlockHostSchema = z.object({
  secret: z.string().min(1).max(10_000),
  persist: z.boolean().optional(),
});

export type HostRouteDeps = {
  db: AppDatabase;
  hosts?: WorkHostService;
  hostFs?: HostFsService;
  runtimeHostSecrets?: Map<string, string>;
};

export function registerHostRoutes(app: FastifyInstance, deps: HostRouteDeps): void {
  const runtimeHostSecrets = deps.runtimeHostSecrets;
  const hosts = deps.hosts ?? createWorkHostService({ db: deps.db, runtimeHostSecrets });
  const hostFs = deps.hostFs ?? createHostFsService({ db: deps.db, runtimeHostSecrets });

  app.get('/api/hosts', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { items: hosts.list() };
  });

  app.get('/api/hosts/wsl/discover', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return hosts.discoverWsl();
  });

  app.post('/api/hosts', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = createHostSchema.parse(request.body ?? {});
    const created = hosts.create(body);
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { hostId: string } }>('/api/hosts/:hostId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = patchHostSchema.parse(request.body ?? {});
    return hosts.update(request.params.hostId, body);
  });

  app.post<{ Params: { hostId: string } }>('/api/hosts/:hostId/connect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return hosts.connect(request.params.hostId);
  });

  app.post<{ Params: { hostId: string } }>('/api/hosts/:hostId/disconnect', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return hosts.disconnect(request.params.hostId);
  });

  app.post<{ Params: { hostId: string } }>('/api/hosts/:hostId/unlock', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = unlockHostSchema.parse(request.body ?? {});
    return hosts.unlock(request.params.hostId, body.secret, Boolean(body.persist));
  });

  app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/fs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = fsBrowseQuerySchema.parse(request.query ?? {});
    const refresh = query.refresh === '1' || query.refresh === 'true';
    return hostFs.listEntries(request.params.hostId, query.path, { refresh });
  });

  app.get<{ Params: { hostId: string } }>('/api/hosts/:hostId/fs/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path } = fsQuerySchema.required().parse(request.query ?? {});
    return hostFs.readPreview(request.params.hostId, path);
  });

  app.put<{ Params: { projectId: string } }>('/api/projects/:projectId/files/text', { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { path, text, baseRevision } = z.object({
      path: z.string().min(1).max(1000),
      text: z.string().max(256 * 1024),
      baseRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    }).parse(request.body ?? {});
    return hostFs.savePreview(request.params.projectId, path, text, baseRevision);
  });

  app.delete<{ Params: { hostId: string } }>('/api/hosts/:hostId', async (request, reply) => {
    const query = deleteHostQuerySchema.parse(request.query ?? {});
    hosts.remove(request.params.hostId, query.baseRevision);
    reply.code(204);
  });
}
