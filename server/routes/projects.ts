import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../errors';
import { hasFeature } from '../features/registry';
import { createHostFsService, type HostFsService } from '../services/host-fs';
import { createWorkGitService } from '../services/work-git';

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

const cliConfigMapSchema = z.object({
  codex: z.string().max(500).optional(),
  antigravity: z.string().max(500).optional(),
  claude: z.string().max(500).optional(),
});

const createProjectSchema = z.object({
  hostId: z.string().min(1).max(120),
  directory: z.string().min(1).max(1000),
  name: z.string().max(120).optional(),
  cliProxies: cliConfigMapSchema.optional(),
  cliArgs: cliConfigMapSchema.optional(),
  proxyUrl: z.string().max(500).optional(),
});

const updateProjectSchema = z.object({
  hostId: z.string().min(1).max(120).optional(),
  directory: z.string().min(1).max(1000).optional(),
  name: z.string().max(120).optional(),
  cliProxies: cliConfigMapSchema.optional(),
  cliArgs: cliConfigMapSchema.optional(),
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
  hostFs?: HostFsService;
  runtimeHostSecrets?: Map<string, string>;
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

  const git = createWorkGitService(db, deps.hostFs ?? createHostFsService({ db, runtimeHostSecrets: deps.runtimeHostSecrets }));
  const gitCommitSchema = z.object({
    message: z.string().trim().min(1).max(1000).refine((value) => !value.includes('\0')),
    paths: z.array(z.string().min(1).max(1024).refine((path) => !path.includes('\0'))).min(1).max(100),
  }).refine(({ paths }) => Buffer.byteLength(paths.join('\0')) <= 12_000, '选中的路径总长度过长，请分批提交。');

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/git', async (request, reply) => {
    if (!hasFeature('work-git')) throw notFound();
    reply.header('Cache-Control', 'no-store');
    return git.status(request.params.projectId);
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/git/graph', async (request, reply) => {
    if (!hasFeature('work-git')) throw notFound();
    reply.header('Cache-Control', 'no-store');
    return git.graph(request.params.projectId);
  });

  app.get<{ Params: { projectId: string; oid: string } }>('/api/projects/:projectId/git/commits/:oid/diff', async (request, reply) => {
    if (!hasFeature('work-git')) throw notFound();
    reply.header('Cache-Control', 'no-store');
    const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).parse(request.params.oid);
    return git.commitDiff(request.params.projectId, oid);
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/git/diff', async (request, reply) => {
    if (!hasFeature('work-git')) throw notFound();
    reply.header('Cache-Control', 'no-store');
    const query = z.object({
      path: z.string().min(1).max(4096).refine((path) => !path.includes('\0')),
      scope: z.enum(['index', 'worktree']),
    }).parse(request.query);
    return git.diff(request.params.projectId, query);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/git/fetch', async (request, reply) => {
    if (!hasFeature('work-git')) throw notFound();
    reply.header('Cache-Control', 'no-store');
    return git.fetch(request.params.projectId);
  });

  app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/git/commits', async (request, reply) => {
    if (!hasFeature('work-git')) throw notFound();
    reply.header('Cache-Control', 'no-store');
    const input = gitCommitSchema.parse(request.body ?? {});
    const result = await git.commit(request.params.projectId, input);
    reply.code(201);
    return result;
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
