import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { createAgentRunService } from '../agent/run-service';

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    name: 'Test Provider',
    protocol: 'completion',
    baseUrl: 'https://api.example.com/v1',
    requiresApiKey: true,
    models: [
      {
        id: 'model-1',
        name: 'Test Model',
        modelId: 'gpt-test',
        supportsImage: false,
        contextWindow: 128_000,
        maxOutput: 4_096,
      },
    ],
    ...overrides,
  };
}

test('server persists model configs and API keys without returning raw keys', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-models-store-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const { app } = await buildApp({ settings });
  try {
    const initial = await app.inject({ method: 'GET', url: '/api/models' });
    assert.equal(initial.statusCode, 200);
    assert.deepEqual(initial.json(), {
      providers: [],
      selectedId: null,
      titleModelId: null,
      memoryModelId: null,
      configuredKeyProviderIds: [],
      revision: 1,
    });

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/models',
      payload: {
        baseRevision: 1,
        providers: [provider()],
        selectedId: 'model-1',
        titleModelId: null,
        memoryModelId: null,
        apiKeys: { 'provider-1': '  sk-top-secret  ' },
      },
    });
    assert.equal(saved.statusCode, 200);
    const savedBody = saved.json<{ revision: number; configuredKeyProviderIds: string[] }>();
    assert.equal(savedBody.revision, 2);
    assert.deepEqual(savedBody.configuredKeyProviderIds, ['provider-1']);
    assert.equal(JSON.stringify(savedBody).includes('sk-top-secret'), false);

    // Updating provider metadata without `apiKeys` keeps the stored API key.
    const edited = await app.inject({
      method: 'PUT',
      url: '/api/models',
      payload: {
        baseRevision: 2,
        providers: [provider({ name: 'Renamed Provider' })],
        selectedId: 'model-1',
        titleModelId: 'model-1',
        memoryModelId: null,
      },
    });
    assert.equal(edited.statusCode, 200);
    assert.deepEqual(edited.json<{ configuredKeyProviderIds: string[] }>().configuredKeyProviderIds, ['provider-1']);

    // Stale baseRevision fails with 409 conflict.
    const conflictRes = await app.inject({
      method: 'PUT',
      url: '/api/models',
      payload: {
        baseRevision: 2,
        providers: [],
        selectedId: null,
        titleModelId: null,
        memoryModelId: null,
      },
    });
    assert.equal(conflictRes.statusCode, 409);

    // Deleting provider removes its saved key.
    const cleared = await app.inject({
      method: 'PUT',
      url: '/api/models',
      payload: {
        baseRevision: 3,
        providers: [],
        selectedId: null,
        titleModelId: null,
        memoryModelId: null,
      },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json<{ configuredKeyProviderIds: string[] }>().configuredKeyProviderIds, []);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('server resolves stored API key for /api/agent/models and /api/agent/runs when omitted by browser', async () => {
  const upstreamHeaders: string[] = [];
  const upstream = createServer((req, res) => {
    upstreamHeaders.push(String(req.headers.authorization ?? ''));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const port = (upstream.address() as AddressInfo).port;

  let seenRunApiKey = '';
  const runs = createAgentRunService({
    loadRunner: async () => ({
      createReplyRun(options) {
        seenRunApiKey = options.apiKey;
        options.onUpdate({ content: 'ok', reasoning: '', reasoningActive: false });
        return {
          abort() {},
          steer() { return false as const; },
          start: async () => ({ status: 'complete' as const }),
        };
      },
    }),
  });

  const directory = mkdtempSync(join(tmpdir(), 'matrius-models-resolve-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const { app } = await buildApp({ settings, runs });
  try {
    await app.inject({
      method: 'PUT',
      url: '/api/models',
      payload: {
        baseRevision: 1,
        providers: [provider({ baseUrl: `http://127.0.0.1:${port}/v1` })],
        selectedId: 'model-1',
        titleModelId: null,
        memoryModelId: null,
        apiKeys: { 'provider-1': 'sk-server-stored' },
      },
    });

    const catalog = await app.inject({
      method: 'POST',
      url: '/api/agent/models',
      payload: {
        providerId: 'provider-1',
        protocol: 'completion',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requiresApiKey: true,
      },
    });
    assert.equal(catalog.statusCode, 200);
    assert.equal(upstreamHeaders[0], 'Bearer sk-server-stored');

    const run = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      payload: {
        conversationId: 'conv-1',
        replyId: 'reply-1',
        model: {
          id: 'model-1',
          name: 'Test Model',
          modelId: 'gpt-test',
          providerId: 'provider-1',
          providerName: 'Test Provider',
          protocol: 'completion',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          requiresApiKey: true,
          supportsImage: false,
          contextWindow: 128_000,
          maxOutput: 4_096,
        },
        messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      },
    });
    assert.equal(run.statusCode, 200);
    assert.equal(seenRunApiKey, 'sk-server-stored');
  } finally {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
