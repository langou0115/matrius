import { z } from 'zod';

export const fileKindSchema = z.enum(['all', 'image', 'file', 'document', 'text']);
export const fileSortSchema = z.enum(['created', 'name', 'size']);
export const fileOrderSchema = z.enum(['asc', 'desc']);

export const listFilesQuerySchema = z.object({
  query: z.string().max(200).optional(),
  kind: fileKindSchema.default('all'),
  sort: fileSortSchema.default('created'),
  order: fileOrderSchema.default('desc'),
  conversationId: z.string().max(128).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const filePatchSchema = z.object({
  filename: z.string().min(1).max(255),
});

export const bulkDeleteFilesSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(100),
});

export const fileIdSchema = z.uuid();
