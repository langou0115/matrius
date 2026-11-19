import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ProviderConfig } from '../../contract/agent-provider';
import type { AppDatabase } from '../db/client';
import { getOrCreateModelSettings, updateModelSettings } from '../db/repositories/models';

const INSTANCE_ID = 1;

const providerModelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  supportsImage: z.boolean(),
  contextWindow: z.number().int().min(1),
  maxOutput: z.number().int().min(1),
  thinkingEffort: z.enum(['default', 'low', 'medium', 'high']).optional(),
});

const providerConfigSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  protocol: z.enum(['completion', 'responses', 'message']),
  baseUrl: z.string().min(1).max(2_000),
  requiresApiKey: z.boolean(),
  models: z.array(providerModelSchema).max(500),
});

const updateModelSettingsSchema = z.object({
  baseRevision: z.number().int().min(1),
  providers: z.array(providerConfigSchema).max(100),
  selectedId: z.string().min(1).max(200).nullable(),
  titleModelId: z.string().min(1).max(200).nullable(),
  memoryModelId: z.string().min(1).max(200).nullable(),
  apiKeys: z.record(z.string().min(1).max(200), z.string().max(10_000).nullable()).optional(),
});

export type ModelRouteDeps = { db: AppDatabase };

export function registerModelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void {
  const { db } = deps;

  app.get('/api/models', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return db.transaction(() => getOrCreateModelSettings(db, INSTANCE_ID));
  });

  app.put('/api/models', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const payload = updateModelSettingsSchema.parse(request.body ?? {});
    return db.transaction(() => updateModelSettings(db, INSTANCE_ID, {
      baseRevision: payload.baseRevision,
      providers: payload.providers as ProviderConfig[],
      selectedId: payload.selectedId,
      titleModelId: payload.titleModelId,
      memoryModelId: payload.memoryModelId,
      ...(payload.apiKeys ? { apiKeys: payload.apiKeys } : {}),
    }));
  });
}
