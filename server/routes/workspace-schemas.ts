import { z } from 'zod';

export const preferencesUpdateSchema = z.object({
  baseRevision: z.number().int().min(1),
  themeId: z.string().min(1).max(64),
  mode: z.enum(['light', 'dark', 'system']),
});

export const profileUpdateSchema = z.object({
  baseRevision: z.number().int().min(1),
  customInstructions: z.string().max(10_000).default(''),
  aboutName: z.string().max(100).default(''),
  occupation: z.string().max(100).default(''),
  aboutMore: z.string().max(4_000).default(''),
});

export const profileFieldUpdateSchema = z.object({
  baseRevision: z.number().int().min(1).nullable().optional(),
  value: z.string().max(20_000).default(''),
  source: z.string().max(32).default('manual'),
  updatedAt: z.number().int().nullable().optional(),
});

export const memoryTypeSchema = z.enum(['identity', 'workflow', 'voice', 'instruction']);
export const memorySourceSchema = z.enum(['manual', 'tool', 'extracted']);
export const memoryScopeSchema = z.enum(['global', 'conversation']);
export const memoryStatusSchema = z.enum(['active', 'archived']);

export const memoryCreateSchema = z.object({
  id: z.uuid().nullable().optional(),
  clientId: z.string().max(200).nullable().optional(),
  scope: memoryScopeSchema.default('global'),
  type: memoryTypeSchema,
  status: memoryStatusSchema.default('active'),
  content: z.string().min(1).max(20_000),
  source: memorySourceSchema.default('manual'),
  createdAt: z.number().int().nullable().optional(),
  updatedAt: z.number().int().nullable().optional(),
});

export const memoryPatchSchema = z.object({
  baseRevision: z.number().int().min(1),
  scope: memoryScopeSchema.nullable().optional(),
  type: memoryTypeSchema.nullable().optional(),
  status: memoryStatusSchema.nullable().optional(),
  content: z.string().min(1).max(20_000).nullable().optional(),
  source: memorySourceSchema.nullable().optional(),
  updatedAt: z.number().int().nullable().optional(),
});

export const listMemoriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(50),
  cursor: z.string().optional(),
  status: memoryStatusSchema.optional(),
  scope: memoryScopeSchema.optional(),
});

export const deleteProfileFieldQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1).nullable().optional(),
});

export const deleteMemoryQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1),
});

export const memoryIdSchema = z.uuid();

export const listConversationDeletionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(100),
  cursor: z.string().optional(),
});
