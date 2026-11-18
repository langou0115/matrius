import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAssistantMessageEventStream, type AssistantMessage } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';

import type {
  AgentRunEvent,
  AgentRunRequest,
  ReplyUpdate,
} from '../../contract/agent-protocol';
import { createReplyRun } from '../agent/runner';
import { createAgentRunService, type AgentRunService } from '../agent/run-service';
import { createToolActivityResolver } from '../agent/tool-activity';
import { toolRegistry } from '../agent/tools';
import { buildApp } from '../app';
import { loadSettings } from '../config';

function model() {
  return {
    id: 'model-1',
    name: 'Test',
    modelId: 'test-model',
    providerId: 'provider-1',
    providerName: 'Provider',
    protocol: 'completion' as const,
    baseUrl: 'https://example.com/v1',
    requiresApiKey: true,
    supportsImage: false,
    contextWindow: 8_000,
    maxOutput: 1_000,
  };
}

function request(conversationId = 'conversation-1'): AgentRunRequest {
  return {
    conversationId,
    replyId: 'reply-1',
    model: model(),
    apiKey: 'test-key',
    thinkingEffort: 'low',
    messages: [{ id: 'user-1', role: 'user', content: 'Hello' }],
    systemPrompt: 'You are a test.',
  };
}

function fakeService(overrides: Partial<AgentRunService> = {}): AgentRunService {
  return {
    start(_request, sink) {
      sink({ type: 'run', runId: 'run-1', conversationId: 'conversation-1', replyId: 'reply-1' });
      sink({
        type: 'update',
        update: { content: 'Hello back', reasoning: '', reasoningActive: false },
      });
      setTimeout(() => sink({ type: 'end', result: { status: 'complete' } }), 0);
      return { accepted: true, runId: 'run-1' };
    },
    steer: () => 'steered',
    stop: () => {},
    isRunning: () => false,
    dispose: () => {},
    ...overrides,
  };
}

async function withServer(
  runs: AgentRunService,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-agent-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
  });
  const { app } = await buildApp({ settings, runs });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the run service bridges updates, usage and a final end event', async () => {
  let aborted = 0;
  const service = createAgentRunService({
    loadRunner: async () => ({
      createReplyRun(options) {
        options.onUpdate({ content: 'partial', reasoning: 'thinking', reasoningActive: false });
        return {
          abort() { aborted += 1; },
          steer() { return false as const; },
          start: async () => ({
            status: 'complete' as const,
            usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 },
          }),
        };
      },
    }),
    loadCompactor: async () => ({
      prepareHistory: async ({ messages, systemPrompt }) => ({
        messages,
        systemPrompt: systemPrompt ?? '',
        compacted: false,
      }),
    }),
  });

  try {
    const events: AgentRunEvent[] = [];
    const ended = new Promise<void>((resolve) => {
      const started = service.start(request(), (event) => {
        events.push(event);
        if (event.type === 'end') resolve();
      });
      assert.equal(started.accepted, true);
    });
    await ended;

    assert.equal(events[0].type, 'run');
    assert.ok(events.some((event) => event.type === 'update' && event.update.content === 'partial'));
    const end = events.find((event) => event.type === 'end');
    assert.ok(end && end.type === 'end');
    assert.equal(end.result.status, 'complete');
    assert.deepEqual(end.result.usage, { input: 10, output: 20, cacheRead: 3, cacheWrite: 4 });
    assert.equal(service.isRunning('conversation-1'), false);
    assert.equal(aborted, 0);
  } finally {
    service.dispose();
  }
});

test('the run service exposes web tools and their prompt to the runner', async () => {
  let tools: string[] = [];
  let systemPrompt = '';
  let hasActivity = false;
  const service = createAgentRunService({
    services: {
      search: { searchMany: async () => [] },
      fetch: { fetch: async () => ({ title: '', url: '', text: '', truncated: false, chars: 0 }) },
    },
    loadRunner: async () => ({
      createReplyRun(options) {
        tools = (options.tools ?? []).map((tool) => tool.name);
        systemPrompt = options.systemPrompt ?? '';
        hasActivity = Boolean(options.toolActivity);
        return {
          abort() {},
          steer() { return false as const; },
          start: async () => ({ status: 'complete' as const }),
        };
      },
    }),
    loadCompactor: async () => ({
      prepareHistory: async ({ messages, systemPrompt: prompt }) => ({
        messages,
        systemPrompt: prompt ?? '',
        compacted: false,
      }),
    }),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const started = service.start(request(), (event) => {
        if (event.type === 'end') {
          if (event.result.status === 'error') reject(new Error(event.result.error));
          else resolve();
        }
      });
      assert.equal(started.accepted, true);
    });
    assert.deepEqual(tools.sort(), ['ask_question', 'file', 'show_weather', 'web_fetch', 'web_search']);
    assert.match(systemPrompt, /Web tools are available/u);
    assert.equal(hasActivity, true);
  } finally {
    service.dispose();
  }
});

test('the SSE route streams run, update and end events', async () => {
  await withServer(fakeService(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request()),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/u);
    const text = await response.text();
    assert.match(text, /event: run/u);
    assert.match(text, /"runId":"run-1"/u);
    assert.match(text, /event: update/u);
    assert.match(text, /Hello back/u);
    assert.match(text, /event: end/u);
    assert.match(text, /"status":"complete"/u);
  });
});

test('the SSE route rejects a second run and proxies steer and stop', async () => {
  const stopped: string[] = [];
  await withServer(fakeService({ isRunning: () => true, stop: (id) => { stopped.push(id); } }), async (baseUrl) => {
    const busy = await fetch(`${baseUrl}/api/agent/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request()),
    });
    assert.equal(busy.status, 409);
    assert.equal(((await busy.json()) as { error: { code: string } }).error.code, 'run_in_progress');

    const steer = await fetch(`${baseUrl}/api/agent/runs/conversation-1/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { id: 'steer-1', role: 'user', content: 'Also check this' } }),
    });
    assert.deepEqual(await steer.json(), { outcome: 'steered' });

    const stop = await fetch(`${baseUrl}/api/agent/runs/conversation-1/stop`, { method: 'POST' });
    assert.deepEqual(await stop.json(), { ok: true });
    assert.deepEqual(stopped, ['conversation-1']);
  });
});

function assistantTemplate(partial: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'provider-1',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...partial,
  };
}

test('createReplyRun streams inline UI markers in-place without prematurely rendering cards at the top', async () => {
  const weatherTool = toolRegistry.enabled(new Set()).find((item) => item.id === 'show_weather');
  assert.ok(weatherTool);
  const tools = [weatherTool.create({
    instanceId: 1,
    conversationId: 'conv-ui-1',
    features: new Set(),
    services: {
      search: { searchMany: async () => [] },
      fetch: { fetch: async () => ({ title: '', url: '', text: '', truncated: false, chars: 0 }) },
    },
  })];
  const toolActivity = createToolActivityResolver(toolRegistry);

  let turn = 0;
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    turn += 1;
    queueMicrotask(() => {
      if (turn === 1) {
        const toolCall = {
          type: 'toolCall' as const,
          id: 'call_1',
          name: 'show_weather',
          arguments: {
            location: '北京',
            condition: 'sunny',
            conditionLabel: '晴',
            temperatureC: 20,
            highC: 22,
            lowC: 12,
          },
        };
        const msg = assistantTemplate({ content: [toolCall], stopReason: 'toolUse' });
        stream.push({ type: 'start', partial: assistantTemplate() });
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: msg });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: msg });
        stream.push({ type: 'done', reason: 'toolUse', message: msg });
        stream.end(msg);
        return;
      }

      const chunks = ['先看北京天气：\n\n', '[[ui:weather-call_1]]', '\n\n记得带伞。'];
      let text = '';
      stream.push({ type: 'start', partial: assistantTemplate() });
      stream.push({ type: 'text_start', contentIndex: 0, partial: assistantTemplate({ content: [{ type: 'text', text: '' }] }) });
      for (const chunk of chunks) {
        text += chunk;
        stream.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: chunk,
          partial: assistantTemplate({ content: [{ type: 'text', text }] }),
        });
      }
      const finalMsg = assistantTemplate({ content: [{ type: 'text', text }] });
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: finalMsg });
      stream.push({ type: 'done', reason: 'stop', message: finalMsg });
      stream.end(finalMsg);
    });
    return stream;
  };

  const updates: ReplyUpdate[] = [];
  const run = createReplyRun({
    config: model(),
    apiKey: 'test-key',
    messages: [{ id: 'u1', role: 'user', content: '北京天气如何？' }],
    tools,
    toolActivity,
    streamFn,
    onUpdate: (value) => updates.push(value),
  });
  const result = await run.start();
  assert.equal(result.status, 'complete');

  const contents = updates.map((item) => item.content);
  const firstMarkerIndex = contents.findIndex((text) => text.includes('[[ui:weather-call_1]]'));
  const firstProseIndex = contents.findIndex((text) => text.includes('先看北京天气：'));
  assert.ok(firstProseIndex >= 0);
  assert.ok(firstMarkerIndex > firstProseIndex);
  assert.equal(contents.at(-1), '先看北京天气：\n\n[[ui:weather-call_1]]\n\n记得带伞。');
});

test('createReplyRun appends omitted UI markers at the end once the reply completes', async () => {
  const weatherTool = toolRegistry.enabled(new Set()).find((item) => item.id === 'show_weather');
  assert.ok(weatherTool);
  const tools = [weatherTool.create({
    instanceId: 1,
    conversationId: 'conv-ui-2',
    features: new Set(),
    services: {
      search: { searchMany: async () => [] },
      fetch: { fetch: async () => ({ title: '', url: '', text: '', truncated: false, chars: 0 }) },
    },
  })];
  const toolActivity = createToolActivityResolver(toolRegistry);

  let turn = 0;
  const streamFn: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    turn += 1;
    queueMicrotask(() => {
      if (turn === 1) {
        const toolCall = {
          type: 'toolCall' as const,
          id: 'call_2',
          name: 'show_weather',
          arguments: {
            location: '上海',
            condition: 'rain',
            conditionLabel: '小雨',
            temperatureC: 18,
            highC: 20,
            lowC: 14,
          },
        };
        const msg = assistantTemplate({ content: [toolCall], stopReason: 'toolUse' });
        stream.push({ type: 'start', partial: assistantTemplate() });
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial: msg });
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: msg });
        stream.push({ type: 'done', reason: 'toolUse', message: msg });
        stream.end(msg);
        return;
      }

      const text = '上海今天有小雨。';
      const msg = assistantTemplate({ content: [{ type: 'text', text }] });
      stream.push({ type: 'start', partial: assistantTemplate() });
      stream.push({ type: 'text_start', contentIndex: 0, partial: assistantTemplate({ content: [{ type: 'text', text: '' }] }) });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: msg });
      stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: msg });
      stream.push({ type: 'done', reason: 'stop', message: msg });
      stream.end(msg);
    });
    return stream;
  };

  const updates: ReplyUpdate[] = [];
  const run = createReplyRun({
    config: model(),
    apiKey: 'test-key',
    messages: [{ id: 'u1', role: 'user', content: '上海天气如何？' }],
    tools,
    toolActivity,
    streamFn,
    onUpdate: (value) => updates.push(value),
  });
  const result = await run.start();
  assert.equal(result.status, 'complete');

  const beforeFinal = updates.slice(0, -1).map((item) => item.content);
  assert.equal(beforeFinal.some((text) => text.includes('[[ui:weather-call_2]]')), false);
  assert.equal(updates.at(-1)?.content, '上海今天有小雨。\n\n[[ui:weather-call_2]]');
});
