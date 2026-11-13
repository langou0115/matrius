import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  AgentRunEvent,
  AgentRunRequest,
} from '../../contract/agent-protocol';
import { createAgentRunService, type AgentRunService } from '../agent/run-service';
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
    assert.deepEqual(tools.sort(), ['file', 'web_fetch', 'web_search']);
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
