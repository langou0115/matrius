import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchProviderCatalog } from '../ui/core/llm/provider-catalog.ts';

test('fetchProviderCatalog queries /api/agent/models instead of /api/model-proxy', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({
      models: [{ id: 'gpt-4o', name: 'gpt-4o' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const models = await fetchProviderCatalog({
    protocol: 'completion',
    baseUrl: 'https://api.example.com/v1/',
    requiresApiKey: true,
  }, ' sk-test ', fetcher);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/agent/models');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, {
    protocol: 'completion',
    baseUrl: 'https://api.example.com/v1',
    requiresApiKey: true,
    apiKey: 'sk-test',
  });
  assert.deepEqual(models, [{ id: 'gpt-4o', name: 'gpt-4o' }]);
});

test('fetchProviderCatalog validates key locally and surfaces server errors', async () => {
  await assert.rejects(
    () => fetchProviderCatalog({
      protocol: 'completion',
      baseUrl: 'https://api.example.com/v1',
      requiresApiKey: true,
    }, '   '),
    /请先在服务商设置中填写 API key/,
  );

  await assert.rejects(
    () => fetchProviderCatalog({
      protocol: 'message',
      baseUrl: 'https://api.anthropic.com',
      requiresApiKey: false,
    }, '', async () => new Response(JSON.stringify({
      error: { code: 'provider_auth_error', message: 'Provider 返回 HTTP 401，请检查 API key 及权限。' },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } })),
    /Provider 返回 HTTP 401/,
  );

  const savedCalls = [];
  const models = await fetchProviderCatalog({
    id: 'provider-saved',
    protocol: 'completion',
    baseUrl: 'https://api.example.com/v1',
    requiresApiKey: true,
  }, '', async (url, init) => {
    savedCalls.push({ url: String(url), init, body: JSON.parse(String(init?.body)) });
    return Response.json({ models: [{ id: 'deepseek-chat', name: 'deepseek-chat' }] });
  }, { providerId: 'provider-saved', hasSavedKey: true });
  assert.equal(savedCalls[0].init.credentials, 'same-origin');
  assert.deepEqual(savedCalls[0].body, {
    providerId: 'provider-saved',
    protocol: 'completion',
    baseUrl: 'https://api.example.com/v1',
    requiresApiKey: true,
  });
  assert.deepEqual(models, [{ id: 'deepseek-chat', name: 'deepseek-chat' }]);
});
