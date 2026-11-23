import type { ServerResponse } from 'node:http';

import type { FastifyInstance } from 'fastify';

import type { AgentRunEvent, AgentRunRequest, Message } from '../../contract/agent-protocol';
import type { AgentRunService } from '../agent/run-service';
import { generateMemorySummary } from '../agent/memory';
import { fetchProviderModels } from '../agent/models';
import { generateConversationTitle } from '../agent/title';
import { validateModelConfig } from '../../contract/agent-provider';
import type { AppDatabase } from '../db/client';
import { getProviderApiKey } from '../db/repositories/models';
import { invalid } from '../errors';
import {
  agentRunSchema,
  agentSteerSchema,
  memoryRequestSchema,
  providerModelsRequestSchema,
  titleRequestSchema,
} from './agent-schemas';

export type AgentRouteDeps = { runs: AgentRunService; db?: AppDatabase };

const INSTANCE_ID = 1;
const HEARTBEAT_MS = 15_000;

function resolveApiKey(
  db: AppDatabase | undefined,
  providerId: string | undefined,
  inlineApiKey: string | undefined,
  requiresApiKey: boolean,
): string {
  if (!requiresApiKey) return '';
  const inline = inlineApiKey?.trim() ?? '';
  if (inline) return inline;
  if (!db || !providerId) return '';
  return getProviderApiKey(db, INSTANCE_ID, providerId);
}

function writeEvent(response: ServerResponse, event: AgentRunEvent): void {
  if (response.writableEnded) return;
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  const { runs, db } = deps;

  app.post('/api/agent/runs', async (request, reply) => {
    const payload = agentRunSchema.parse(request.body);
    if (runs.isRunning(payload.conversationId)) {
      reply.code(409);
      return { error: { code: 'run_in_progress', message: '当前会话正在生成回复。' } };
    }
    const apiKey = resolveApiKey(
      db,
      payload.model.providerId,
      payload.apiKey,
      payload.model.requiresApiKey,
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    let ended = false;
    const close = () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {
        // The peer may already be gone.
      }
    };
    const heartbeat = setInterval(() => {
      if (!ended && !reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    reply.raw.on('close', () => {
      if (ended) return;
      ended = true;
      clearInterval(heartbeat);
      runs.stop(payload.conversationId);
    });

    try {
      runs.start({ ...(payload as unknown as AgentRunRequest), apiKey }, (event) => {
        if (ended) return;
        writeEvent(reply.raw, event);
        if (event.type === 'end') close();
      });
    } catch (error) {
      if (!ended) {
        writeEvent(reply.raw, {
          type: 'end',
          result: { status: 'error', error: error instanceof Error ? error.message : '无法启动回复。' },
        });
        close();
      }
    }
  });

  app.post('/api/agent/title', async (request) => {
    const payload = titleRequestSchema.parse(request.body);
    let config;
    try {
      config = validateModelConfig(payload.model as never);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : '模型配置不合法。');
    }
    return {
      title: await generateConversationTitle({
        config,
        logTrace: (trace) => request.log.info({ trace }, 'Matrius Agent title'),
        apiKey: resolveApiKey(db, config.providerId, payload.apiKey, config.requiresApiKey),
        content: payload.content,
        ...(payload.quote ? { quote: payload.quote } : {}),
      }),
    };
  });

  app.post('/api/agent/memory', async (request) => {
    const payload = memoryRequestSchema.parse(request.body);
    let config;
    try {
      config = validateModelConfig(payload.model as never);
    } catch (error) {
      throw invalid(error instanceof Error ? error.message : '模型配置不合法。');
    }
    return {
      summary: await generateMemorySummary({
        config,
        logTrace: (trace) => request.log.info({ trace }, 'Matrius Agent memory'),
        apiKey: resolveApiKey(db, config.providerId, payload.apiKey, config.requiresApiKey),
        instruction: payload.instruction,
        currentSummary: payload.currentSummary,
        userMessage: payload.userMessage,
        assistantMessage: payload.assistantMessage,
      }),
    };
  });

  app.post('/api/agent/models', async (request) => {
    const payload = providerModelsRequestSchema.parse(request.body);
    return {
      models: await fetchProviderModels({
        protocol: payload.protocol,
        baseUrl: payload.baseUrl,
        requiresApiKey: payload.requiresApiKey,
        apiKey: resolveApiKey(db, payload.providerId, payload.apiKey, payload.requiresApiKey),
      }),
    };
  });

  app.post('/api/agent/runs/:conversationId/steer', async (request) => {
    const conversationId = String(
      (request.params as Record<string, unknown>).conversationId,
    );
    const payload = agentSteerSchema.parse(request.body);
    return { outcome: runs.steer(conversationId, payload.message as unknown as Message) };
  });

  app.post('/api/agent/runs/:conversationId/stop', async (request) => {
    const conversationId = String(
      (request.params as Record<string, unknown>).conversationId,
    );
    runs.stop(conversationId);
    return { ok: true };
  });

  app.get('/api/agent/runs/:conversationId', async (request) => {
    const conversationId = String(
      (request.params as Record<string, unknown>).conversationId,
    );
    return { running: runs.isRunning(conversationId) };
  });
}
