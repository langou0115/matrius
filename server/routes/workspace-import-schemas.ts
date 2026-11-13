import { z } from 'zod';

import {
  contextSummarySchema,
  processSchema,
  readStateSchema,
  webActivitySchema,
} from './conversation-schemas';

const importMessageSchema = z.object({
  id: z.string().max(128).nullable().optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(1_000_000).default(''),
  steering: z.boolean().default(false),
  quote: z.string().max(1_000_000).nullable().optional(),
  feedback: z.enum(['good', 'bad']).nullable().optional(),
  reasoning: z.string().max(1_000_000).nullable().optional(),
  thinkingMs: z.number().int().min(0).nullable().optional(),
  status: z.enum(['complete', 'stopped', 'error']).default('complete'),
  error: z.string().max(10_000).nullable().optional(),
  fileIds: z.array(z.uuid()).max(20).default([]),
  activities: z.array(webActivitySchema).max(50).default([]),
  process: processSchema.nullable().optional(),
});

const importConversationSchema = z.object({
  id: z.string().min(1).max(128),
  title: z.string().max(500).default(''),
  pinned: z.boolean().default(false),
  updatedAt: z.number().int().nullable().optional(),
  modelId: z.string().max(200).nullable().optional(),
  titleSource: z.enum(['auto', 'ai', 'manual']).nullable().optional(),
  contextSummary: contextSummarySchema.nullable().optional(),
  readState: readStateSchema.nullable().optional(),
  messages: z.array(importMessageSchema).max(2_000).default([]),
});

const importChatSchema = z.object({
  conversations: z.array(importConversationSchema).max(20).default([]),
  deletedConversationIds: z.array(z.string().min(1).max(128)).max(2_000).default([]),
});

const importAppearanceSchema = z.object({
  themeId: z.string().min(1).max(64),
  mode: z.enum(['light', 'dark', 'system']),
});

const importPersonalizationSchema = z.object({
  customInstructions: z.string().max(10_000).default(''),
  aboutName: z.string().max(100).default(''),
  occupation: z.string().max(100).default(''),
  aboutMore: z.string().max(4_000).default(''),
});

export const workspaceImportSchema = z.object({
  schemaVersion: z.number().int(),
  chat: importChatSchema.default({
    conversations: [],
    deletedConversationIds: [],
  }),
  appearance: importAppearanceSchema.nullable().optional(),
  personalization: importPersonalizationSchema.nullable().optional(),
});

export type WorkspaceImportRequest = z.infer<typeof workspaceImportSchema>;
export type ImportConversation = z.infer<typeof importConversationSchema>;
export type ImportMessage = z.infer<typeof importMessageSchema>;
