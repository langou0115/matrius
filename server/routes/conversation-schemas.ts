import { z } from 'zod';

import type {
  StoredProcessActivity,
  StoredWebActivity,
  StoredWebSearchResult,
} from '../../contract/agent-protocol';

const httpUrl = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'URL must use http or https.',
  });

const searchResultSchema = z.object({
  title: z.string().max(300).default(''),
  url: httpUrl,
  domain: z.string().max(300).default(''),
  rank: z.number().int().min(0).default(0),
});

const activityStatus = z.enum(['running', 'complete', 'stopped', 'error']);

export const webActivitySchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(['search', 'fetch', 'file']),
  status: activityStatus,
  query: z.string().max(500).nullable().optional(),
  queries: z.array(z.string()).max(4).nullable().optional(),
  results: z.array(searchResultSchema).max(20).default([]),
  url: httpUrl.nullable().optional(),
  urls: z.array(httpUrl).max(10).default([]),
  title: z.string().max(300).nullable().optional(),
  operation: z.string().max(40).nullable().optional(),
  fileId: z.string().max(80).nullable().optional(),
  savedFileId: z.string().max(80).nullable().optional(),
  filename: z.string().max(300).nullable().optional(),
  size: z.number().int().min(0).nullable().optional(),
  warning: z.string().max(1_000).nullable().optional(),
  tookMs: z.number().int().min(0).nullable().optional(),
  error: z.string().max(1_000).nullable().optional(),
  startedAt: z.number().int().min(0).nullable().optional(),
  endedAt: z.number().int().min(0).nullable().optional(),
});

const thinkingActivitySchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.literal('thinking'),
  content: z.string().max(1_000_000).default(''),
  status: activityStatus,
  startedAt: z.number().int().min(0).nullable().optional(),
  endedAt: z.number().int().min(0).nullable().optional(),
});

export const processSchema = z
  .array(z.discriminatedUnion('kind', [thinkingActivitySchema, webActivitySchema]))
  .max(100);

export const contextSummarySchema = z.object({
  coveredUntilMessageId: z.string().min(1).max(128),
  summary: z.string().min(1).max(100_000),
});

const readMarkerSchema = z.object({
  state: z.enum(['absent', 'unread', 'read']),
  readAt: z.number().int().min(0).nullable().optional(),
});

export const readStateSchema = z.object({
  completed: readMarkerSchema.nullable().optional(),
  error: readMarkerSchema.nullable().optional(),
});

export const conversationCreateSchema = z.object({
  id: z.uuid().nullable().optional(),
  clientId: z.string().max(200).nullable().optional(),
  title: z.string().max(500).default(''),
  pinned: z.boolean().default(false),
  modelId: z.string().max(200).nullable().optional(),
  titleSource: z.enum(['auto', 'ai', 'manual']).nullable().optional(),
  contextSummary: contextSummarySchema.nullable().optional(),
  updatedAt: z.number().int().nullable().optional(),
});

export const conversationPatchSchema = z.object({
  baseRevision: z.number().int().min(1),
  title: z.string().max(500).nullable().optional(),
  pinned: z.boolean().nullable().optional(),
  modelId: z.string().max(200).nullable().optional(),
  titleSource: z.enum(['auto', 'ai', 'manual']).nullable().optional(),
  contextSummary: contextSummarySchema.nullable().optional(),
  readState: readStateSchema.nullable().optional(),
});

export const messageCreateSchema = z.object({
  id: z.uuid().nullable().optional(),
  clientId: z.string().max(200).nullable().optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(1_000_000).default(''),
  steering: z.boolean().default(false),
  quote: z.string().max(1_000_000).nullable().optional(),
  reasoning: z.string().max(1_000_000).nullable().optional(),
  thinkingMs: z.number().int().min(0).nullable().optional(),
  status: z.enum(['complete', 'stopped', 'error']).default('complete'),
  error: z.string().max(10_000).nullable().optional(),
  feedback: z.enum(['good', 'bad']).nullable().optional(),
  fileIds: z.array(z.uuid()).max(20).default([]),
  activities: z.array(webActivitySchema).max(50).default([]),
  process: processSchema.nullable().optional(),
});

export const messagePatchSchema = z.object({
  baseRevision: z.number().int().min(1),
  content: z.string().max(1_000_000).nullable().optional(),
  quote: z.string().max(1_000_000).nullable().optional(),
  reasoning: z.string().max(1_000_000).nullable().optional(),
  thinkingMs: z.number().int().min(0).nullable().optional(),
  status: z.enum(['complete', 'stopped', 'error']).nullable().optional(),
  error: z.string().max(10_000).nullable().optional(),
  feedback: z.enum(['good', 'bad']).nullable().optional(),
  fileIds: z.array(z.uuid()).max(20).nullable().optional(),
  activities: z.array(webActivitySchema).max(50).nullable().optional(),
  process: processSchema.nullable().optional(),
});

export const listConversationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).default(50),
  cursor: z.string().optional(),
});

export const getConversationQuerySchema = z.object({
  messageLimit: z.coerce.number().int().min(1).default(50),
  before: z.string().optional(),
});

export const deleteConversationQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1),
});

export const deleteMessageQuerySchema = z.object({
  baseRevision: z.coerce.number().int().min(1),
});

export const conversationIdSchema = z.uuid();
export const messageIdSchema = z.uuid();

function normalizeSearchResult(value: z.infer<typeof searchResultSchema>): StoredWebSearchResult {
  return {
    url: value.url,
    ...(value.title ? { title: value.title } : {}),
    ...(value.domain ? { domain: value.domain } : {}),
    ...(value.rank ? { rank: value.rank } : {}),
  };
}

function normalizeWebActivity(value: z.infer<typeof webActivitySchema>): StoredWebActivity {
  const results = value.results.map(normalizeSearchResult);
  return {
    id: value.id,
    kind: value.kind,
    status: value.status,
    ...(value.query !== null && value.query !== undefined ? { query: value.query } : {}),
    ...(value.queries !== null && value.queries !== undefined ? { queries: value.queries } : {}),
    ...(results.length ? { results } : {}),
    ...(value.url !== null && value.url !== undefined ? { url: value.url } : {}),
    ...(value.urls.length ? { urls: value.urls } : {}),
    ...(value.title !== null && value.title !== undefined ? { title: value.title } : {}),
    ...(value.operation !== null && value.operation !== undefined ? { operation: value.operation } : {}),
    ...(value.fileId !== null && value.fileId !== undefined ? { fileId: value.fileId } : {}),
    ...(value.savedFileId !== null && value.savedFileId !== undefined ? { savedFileId: value.savedFileId } : {}),
    ...(value.filename !== null && value.filename !== undefined ? { filename: value.filename } : {}),
    ...(value.size !== null && value.size !== undefined ? { size: value.size } : {}),
    ...(value.warning !== null && value.warning !== undefined ? { warning: value.warning } : {}),
    ...(value.tookMs !== null && value.tookMs !== undefined ? { tookMs: value.tookMs } : {}),
    ...(value.error !== null && value.error !== undefined ? { error: value.error } : {}),
    ...(value.startedAt !== null && value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(value.endedAt !== null && value.endedAt !== undefined ? { endedAt: value.endedAt } : {}),
  };
}

/** Match Pydantic's `exclude_none=True, exclude_defaults=True` for stored activities. */
export function normalizeActivities(
  values: Array<z.infer<typeof webActivitySchema>> | null | undefined,
): StoredWebActivity[] | null {
  if (!values?.length) return null;
  return values.map(normalizeWebActivity);
}

type ProcessValue = z.infer<typeof thinkingActivitySchema> | z.infer<typeof webActivitySchema>;

/** Keep process event order and use the same normalization as the Python payload. */
export function normalizeProcess(
  values: ProcessValue[] | null | undefined,
): StoredProcessActivity[] | null {
  if (!values?.length) return null;
  return values.map((value) => {
    if (value.kind === 'thinking') {
      return {
        id: value.id,
        kind: 'thinking',
        content: value.content,
        status: value.status,
        ...(value.startedAt !== null && value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
        ...(value.endedAt !== null && value.endedAt !== undefined ? { endedAt: value.endedAt } : {}),
      };
    }
    return normalizeWebActivity(value);
  });
}
