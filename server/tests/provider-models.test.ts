import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { fetchProviderModels } from '../agent/models';
import { loadSettings } from '../config';
import { AppError } from '../errors';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withApp(fn: (ctx: Awaited<ReturnType<typeof buildApp>>) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-models-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const ctx = await buildApp({ settings });
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('fetchProviderModels fetches OpenAI-compatible catalog with bearer token and deduplicates', async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers) });
    return jsonResponse({
      data: [
        { id: 'gpt-4o-mini' },
        { id: 'gpt-4o' },
        { id: 'gpt-4o' },
      ],
    });
  };

  const models = await fetchProviderModels({
    protocol: 'completion',
    baseUrl: 'https://api.example.com/v1/',
    requiresApiKey: true,
    apiKey: 'sk-test-123',
    fetcher,
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://api.example.com/v1/models');
  assert.equal(seen[0].headers.get('authorization'), 'Bearer sk-test-123');
  assert.deepEqual(models, [
    { id: 'gpt-4o', name: 'gpt-4o' },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
  ]);
});

test('fetchProviderModels supports custom subpaths and 404 fallback', async () => {
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url === 'https://gateway.example.com/api/v3/models') {
      return jsonResponse({ error: 'not found' }, 404);
    }
    return jsonResponse({ models: [{ id: 'ep-1', name: 'Doubao Pro' }] });
  };

  const models = await fetchProviderModels({
    protocol: 'responses',
    baseUrl: 'https://gateway.example.com/api/v3',
    requiresApiKey: true,
    apiKey: 'Bearer already-prefixed',
    fetcher,
  });

  assert.deepEqual(urls, [
    'https://gateway.example.com/api/v3/models',
    'https://gateway.example.com/api/v3/v1/models',
  ]);
  assert.deepEqual(models, [{ id: 'ep-1', name: 'Doubao Pro' }]);
});

test('fetchProviderModels paginates Anthropic catalog with x-api-key', async () => {
  const requests: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    if (!url.includes('after_id=')) {
      return jsonResponse({
        data: [{ id: 'claude-3-5-haiku', display_name: 'Claude 3.5 Haiku' }],
        has_more: true,
      });
    }
    return jsonResponse({
      data: [{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4' }],
      has_more: false,
    });
  };

  const models = await fetchProviderModels({
    protocol: 'message',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    apiKey: 'ant-key',
    fetcher,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(requests[1].url, 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-3-5-haiku');
  assert.equal(requests[0].headers.get('x-api-key'), 'ant-key');
  assert.equal(requests[0].headers.get('anthropic-version'), '2023-06-01');
  assert.equal(requests[0].headers.get('anthropic-dangerous-direct-browser-access'), null);
  assert.deepEqual(models, [
    { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku' },
    { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  ]);
});

test('fetchProviderModels maps auth, JSON, empty, timeout and network errors cleanly', async () => {
  await assert.rejects(
    () => fetchProviderModels({
      protocol: 'completion',
      baseUrl: 'https://api.example.com/v1',
      requiresApiKey: true,
      apiKey: '   ',
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 422,
  );

  await assert.rejects(
    () => fetchProviderModels({
      protocol: 'completion',
      baseUrl: 'https://api.example.com/v1',
      requiresApiKey: false,
      fetcher: async () => new Response('unauthorized', { status: 401 }),
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 502 && error.code === 'provider_auth_error',
  );

  await assert.rejects(
    () => fetchProviderModels({
      protocol: 'completion',
      baseUrl: 'https://api.example.com/v1',
      requiresApiKey: false,
      fetcher: async () => new Response('not-json', { status: 200 }),
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 502 && error.code === 'provider_invalid_response',
  );

  await assert.rejects(
    () => fetchProviderModels({
      protocol: 'completion',
      baseUrl: 'https://api.example.com/v1',
      requiresApiKey: false,
      fetcher: async () => jsonResponse({ data: [] }),
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 502 && error.code === 'provider_empty_catalog',
  );

  await assert.rejects(
    () => fetchProviderModels({
      protocol: 'completion',
      baseUrl: 'https://api.example.com/v1',
      requiresApiKey: false,
      timeoutMs: 15,
      fetcher: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }),
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 504 && error.code === 'provider_timeout',
  );

  await assert.rejects(
    () => fetchProviderModels({
      protocol: 'completion',
      baseUrl: 'https://api.example.com/v1',
      requiresApiKey: false,
      fetcher: async () => { throw new TypeError('fetch failed'); },
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 502 && error.code === 'provider_network_error',
  );
});

test('POST /api/agent/models validates input and fetches models from upstream', async () => {
  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer test-secret') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  try {
    await withApp(async (ctx) => {
      const missingKey = await ctx.app.inject({
        method: 'POST',
        url: '/api/agent/models',
        payload: { protocol: 'completion', baseUrl, requiresApiKey: true },
      });
      assert.equal(missingKey.statusCode, 422);

      const badUrl = await ctx.app.inject({
        method: 'POST',
        url: '/api/agent/models',
        payload: { protocol: 'completion', baseUrl: 'https://user:pass@example.com/v1', requiresApiKey: false },
      });
      assert.equal(badUrl.statusCode, 422);

      const ok = await ctx.app.inject({
        method: 'POST',
        url: '/api/agent/models',
        payload: { protocol: 'completion', baseUrl, requiresApiKey: true, apiKey: 'test-secret' },
      });
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.json(), {
        models: [
          { id: 'model-a', name: 'model-a' },
          { id: 'model-b', name: 'model-b' },
        ],
      });
    });
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
