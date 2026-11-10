import http from 'node:http';

import { CopilotRuntime } from '@copilotkit/runtime/v2';
import { createCopilotNodeListener } from '@copilotkit/runtime/v2/node';

import type { ModelConfig } from '@/core/llm/model-config';
import type { Message } from '@/core/agent/types';
import { generateMemorySummary } from '@/core/agent/memory';
import { generateConversationTitle } from '@/core/agent/title';

import { MatriusCopilotAgent, readRunContext } from './copilot';
import { config, log } from './env';
import { executeRun, steerRun, stopRun, type RunRequest } from './runs';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

type Reply = http.ServerResponse;

function sendJson(res: Reply, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function sendError(res: Reply, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求内容过大。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) { resolve({}); return; }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON。'));
      }
    });
    req.on('error', reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`缺少 ${field}。`);
  return value;
}

function parseRunRequest(body: unknown): RunRequest {
  const input = asRecord(body);
  const model = asRecord(input.config);
  if (typeof model.id !== 'string' || typeof model.modelId !== 'string') throw new Error('缺少模型配置。');
  if (!Array.isArray(input.messages)) throw new Error('缺少对话历史。');
  const toolset = asRecord(input.toolset);
  return {
    conversationId: requireString(input.conversationId, 'conversationId'),
    replyId: requireString(input.replyId, 'replyId'),
    messages: input.messages as Message[],
    config: input.config as ModelConfig,
    apiKey: typeof input.apiKey === 'string' ? input.apiKey : '',
    thinkingEffort: typeof input.thinkingEffort === 'string' ? input.thinkingEffort as RunRequest['thinkingEffort'] : undefined,
    systemPrompt: typeof input.systemPrompt === 'string' ? input.systemPrompt : '',
    contextSummary: input.contextSummary as RunRequest['contextSummary'],
    toolset: {
      web: toolset.web === true,
      files: toolset.files === true,
      availableFiles: Array.isArray(toolset.availableFiles) ? toolset.availableFiles as NonNullable<RunRequest['toolset']>['availableFiles'] : [],
    },
  };
}

async function handleRun(req: http.IncomingMessage, res: Reply): Promise<void> {
  let request: RunRequest;
  try {
    request = parseRunRequest(await readJson(req));
  } catch (error) {
    sendError(res, 400, 'invalid_request', error instanceof Error ? error.message : '请求无效。');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let finished = false;
  const write = (event: string, data: unknown) => {
    if (finished || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!finished && !res.writableEnded) res.write(': ping\n\n');
  }, config.heartbeatMs);

  // A dropped tab must stop the provider stream instead of billing an abandoned run.
  res.on('close', () => {
    if (!finished) stopRun(request.conversationId);
  });

  try {
    await executeRun(request, write);
  } finally {
    finished = true;
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

async function handleSteer(req: http.IncomingMessage, res: Reply): Promise<void> {
  try {
    const body = asRecord(await readJson(req));
    const conversationId = requireString(body.conversationId, 'conversationId');
    if (!body.message || typeof body.message !== 'object') throw new Error('缺少要补充的消息。');
    sendJson(res, 200, { outcome: steerRun(conversationId, body.message as Message) });
  } catch (error) {
    sendError(res, 400, 'invalid_request', error instanceof Error ? error.message : '请求无效。');
  }
}

async function handleStop(req: http.IncomingMessage, res: Reply): Promise<void> {
  try {
    const body = asRecord(await readJson(req));
    sendJson(res, 200, { stopped: stopRun(requireString(body.conversationId, 'conversationId')) });
  } catch (error) {
    sendError(res, 400, 'invalid_request', error instanceof Error ? error.message : '请求无效。');
  }
}

async function handleTitle(req: http.IncomingMessage, res: Reply): Promise<void> {
  try {
    const body = asRecord(await readJson(req));
    const title = await generateConversationTitle({
      config: body.config as ModelConfig,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
      content: typeof body.content === 'string' ? body.content : '',
      quote: typeof body.quote === 'string' ? body.quote : undefined,
    });
    sendJson(res, 200, { title });
  } catch (error) {
    sendError(res, 400, 'title_failed', error instanceof Error ? error.message : '标题生成失败。');
  }
}

async function handleMemory(req: http.IncomingMessage, res: Reply): Promise<void> {
  try {
    const body = asRecord(await readJson(req));
    const summary = await generateMemorySummary({
      config: body.config as ModelConfig,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : '',
      currentSummary: typeof body.currentSummary === 'string' ? body.currentSummary : '',
      userMessage: typeof body.userMessage === 'string' ? body.userMessage : '',
      assistantMessage: typeof body.assistantMessage === 'string' ? body.assistantMessage : '',
    });
    sendJson(res, 200, { summary });
  } catch (error) {
    sendError(res, 400, 'memory_failed', error instanceof Error ? error.message : '记忆整理失败。');
  }
}

export function createAgentServer(): http.Server {
  // CopilotKit resolves an agent per request, which keeps visitor model keys request-scoped.
  const copilotRuntime = new CopilotRuntime({
    agents: ({ request }) => ({ default: new MatriusCopilotAgent(readRunContext(request)) }),
    // Matrius is a single-instance deployment: every client shares one workspace.
    threads: { access: 'open' },
  });
  const copilot = createCopilotNodeListener({ runtime: copilotRuntime, basePath: '/api/copilotkit' });

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://agent.invalid');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;
    if (url.pathname === '/api/copilotkit' || url.pathname.startsWith('/api/copilotkit/')) {
      void copilot(req, res).catch((error: unknown) => {
        if (res.headersSent) { res.end(); return; }
        sendError(res, 500, 'copilot_failed', error instanceof Error ? error.message : 'CopilotKit 请求失败。');
      });
      return;
    }
    switch (route) {
      case 'GET /health':
        sendJson(res, 200, { status: 'ok' });
        return;
      case 'POST /api/agent/run':
        void handleRun(req, res);
        return;
      case 'POST /api/agent/steer':
        void handleSteer(req, res);
        return;
      case 'POST /api/agent/stop':
        void handleStop(req, res);
        return;
      case 'POST /api/agent/title':
        void handleTitle(req, res);
        return;
      case 'POST /api/agent/memory':
        void handleMemory(req, res);
        return;
      default:
        sendError(res, 404, 'not_found', 'Not Found');
    }
  });
}

const server = createAgentServer();
server.listen(config.port, config.host, () => {
  log(`listening on http://${config.host}:${config.port} (api: ${config.apiBaseUrl})`);
});
