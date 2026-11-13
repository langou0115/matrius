import { z } from 'zod';

export const modelSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  modelId: z.string().min(1).max(200),
  providerId: z.string().min(1).max(200),
  providerName: z.string().min(1).max(200),
  protocol: z.enum(['completion', 'responses', 'message']),
  baseUrl: z.string().url().max(2_000),
  requiresApiKey: z.boolean(),
  supportsImage: z.boolean(),
  contextWindow: z.number().int().min(1),
  maxOutput: z.number().int().min(1),
  thinkingEffort: z.enum(['default', 'low', 'medium', 'high', 'xhigh']).optional(),
});

const messageFileSchema = z.object({
  id: z.string().min(1).max(80),
  filename: z.string().min(1).max(300),
  contentType: z.string().max(255),
  size: z.number().int().min(0),
  revision: z.number().int().min(0).optional(),
  operation: z.string().max(40).optional(),
});

const messageImageSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(300),
  mimeType: z.string().min(1).max(100),
  dataUrl: z.string().min(1).max(30_000_000),
  size: z.number().int().min(0).optional(),
  fileId: z.string().max(80).optional(),
});

export const agentMessageSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(1_000_000),
  quote: z.string().max(1_000_000).optional(),
  feedback: z.enum(['good', 'bad']).optional(),
  steering: z.literal(true).optional(),
  images: z.array(messageImageSchema).max(20).optional(),
  fileIds: z.array(z.string().uuid()).max(20).optional(),
  files: z.array(messageFileSchema).max(20).optional(),
  reasoning: z.string().max(1_000_000).optional(),
  reasoningActive: z.boolean().optional(),
  activities: z.array(z.unknown()).max(50).optional(),
  process: z.array(z.unknown()).max(100).optional(),
  thinkingMs: z.number().int().min(0).optional(),
  status: z.enum(['streaming', 'complete', 'stopped', 'error']).optional(),
  error: z.string().max(10_000).optional(),
});

export const agentRunSchema = z.object({
  conversationId: z.string().min(1).max(128),
  replyId: z.string().min(1).max(128),
  model: modelSchema,
  apiKey: z.string().max(10_000).optional(),
  thinkingEffort: z.enum(['default', 'low', 'medium', 'high']).optional(),
  messages: z.array(agentMessageSchema).max(1_000),
  systemPrompt: z.string().max(100_000).optional(),
  memoryText: z.string().max(30_000).optional(),
  contextSummary: z.object({
    coveredUntilMessageId: z.string().min(1).max(128),
    summary: z.string().min(1).max(100_000),
  }).optional(),
  tools: z.object({
    web: z.boolean().optional(),
    files: z.boolean().optional(),
  }).optional(),
});

export const titleRequestSchema = z.object({
  model: modelSchema,
  apiKey: z.string().max(10_000).optional(),
  content: z.string().min(1).max(4_000),
  quote: z.string().max(2_000).optional(),
});

export const memoryRequestSchema = z.object({
  model: modelSchema,
  apiKey: z.string().max(10_000).optional(),
  currentSummary: z.string().max(4_000).default(''),
  userMessage: z.string().min(1).max(6_000),
  assistantMessage: z.string().max(4_000).default(''),
});

export const agentSteerSchema = z.object({
  message: agentMessageSchema,
});
