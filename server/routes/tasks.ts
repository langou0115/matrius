import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppDatabase } from '../db/client';
import { notFound } from '../errors';
import { hasFeature } from '../features/registry';
import { createScheduledTaskService } from '../services/tasks';

const MAX_INTERVAL_MINUTES = 525_600;

const createTaskSchema = z.object({
  title: z.string().max(200).optional(),
  prompt: z.string().trim().min(1, '请输入任务 Prompt。').max(20_000),
  kind: z.enum(['recurring', 'once']),
  intervalMinutes: z.number().int().min(1).max(MAX_INTERVAL_MINUTES).nullable().optional(),
  runAtMs: z.number().int().positive().nullable().optional(),
  conversationClientId: z.string().trim().min(1).max(128).nullable().optional(),
});

const patchTaskSchema = z.object({
  title: z.string().max(200).optional(),
  prompt: z.string().trim().min(1, '请输入任务 Prompt。').max(20_000).optional(),
  kind: z.enum(['recurring', 'once']).optional(),
  intervalMinutes: z.number().int().min(1).max(MAX_INTERVAL_MINUTES).nullable().optional(),
  runAtMs: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  baseRevision: z.number().int().min(1).optional(),
});

const triggerTaskSchema = z.object({
  conversationClientId: z.string().trim().min(1).max(128),
  triggeredAtMs: z.number().int().positive().optional(),
});

function requireTasksFeature(): void {
  if (!hasFeature('tasks')) throw notFound('定时任务功能未开启。');
}

export function registerTaskRoutes(app: FastifyInstance, deps: { db: AppDatabase }): void {
  const tasks = createScheduledTaskService(deps.db);

  app.get('/api/tasks', async () => {
    requireTasksFeature();
    return { items: tasks.list() };
  });

  app.post('/api/tasks', async (request, reply) => {
    requireTasksFeature();
    const body = createTaskSchema.parse(request.body ?? {});
    const created = tasks.create(body);
    reply.code(201);
    return created;
  });

  app.patch<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (request) => {
    requireTasksFeature();
    const body = patchTaskSchema.parse(request.body ?? {});
    return tasks.patch(request.params.taskId, body);
  });

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/trigger', async (request) => {
    requireTasksFeature();
    const body = triggerTaskSchema.parse(request.body ?? {});
    return tasks.trigger(request.params.taskId, body.conversationClientId, body.triggeredAtMs);
  });

  app.delete<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (request, reply) => {
    requireTasksFeature();
    tasks.remove(request.params.taskId);
    reply.code(204);
  });
}
