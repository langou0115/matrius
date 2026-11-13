import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

type Json = Record<string, unknown>;

async function withApp(fn: (app: Awaited<ReturnType<typeof buildApp>>['app']) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-usage-'));
  const settings = loadSettings({
    APP_ENV: 'test',
    DATA_DIR: directory,
    LOG_LEVEL: 'silent',
  });
  const { app } = await buildApp({ settings });
  try {
    await fn(app);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function body<T = Json>(response: { json: () => unknown }): T {
  return response.json() as T;
}

test('usage reports accumulate per day and zero reports write nothing', async () => {
  await withApp(async (app) => {
    const zero = await app.inject({
      method: 'POST',
      url: '/api/usage',
      payload: { inputTokens: 0, outputTokens: 0 },
    });
    assert.equal(zero.statusCode, 200);
    assert.deepEqual(body(zero), { ok: true });

    const first = await app.inject({
      method: 'POST',
      url: '/api/usage',
      payload: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5 },
    });
    assert.equal(first.statusCode, 200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/usage',
      payload: { inputTokens: 50, outputTokens: 10 },
    });
    assert.equal(second.statusCode, 200);

    const usage = await app.inject({ method: 'GET', url: '/api/usage?days=1' });
    assert.equal(usage.statusCode, 200);
    const payload = body<{
      items: Array<{ input: number; output: number; cacheRead: number; cacheWrite: number; requests: number; total: number; estimated: boolean }>;
      lifetime: { input: number; output: number; requests: number; total: number };
      estimated: { total: number };
      backfilled: boolean;
    }>(usage);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].input, 150);
    assert.equal(payload.items[0].output, 30);
    assert.equal(payload.items[0].cacheRead, 30);
    assert.equal(payload.items[0].cacheWrite, 5);
    assert.equal(payload.items[0].requests, 2);
    assert.equal(payload.items[0].total, 215);
    assert.equal(payload.items[0].estimated, false);
    assert.equal(payload.lifetime.requests, 2);
    assert.equal(payload.lifetime.total, 215);
    assert.equal(payload.estimated.total, 0);
    assert.equal(payload.backfilled, false);

    const outOfRange = await app.inject({
      method: 'POST',
      url: '/api/usage',
      payload: { date: '2000-01-01', inputTokens: 1 },
    });
    assert.equal(outOfRange.statusCode, 422);
  });
});

test('backfill estimates historical messages once and is marked in the response', async () => {
  await withApp(async (app) => {
    const conversation = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { title: 'Historical' },
    });
    const conversationId = String(body(conversation).id);
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { role: 'user', content: 'A question about TypeScript.' },
    });
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { role: 'assistant', content: 'A useful answer.', reasoning: 'Consider the options.' },
    });

    const backfill = await app.inject({
      method: 'POST',
      url: '/api/usage/backfill',
      payload: { utcOffsetMinutes: 0 },
    });
    assert.equal(backfill.statusCode, 200);
    const result = body<{ backfilled: boolean; skipped: boolean; days: number; requests: number; total: number }>(backfill);
    assert.equal(result.backfilled, true);
    assert.equal(result.skipped, false);
    assert.equal(result.days, 1);
    assert.equal(result.requests, 1);
    assert.ok(result.total > 0);

    const repeated = await app.inject({
      method: 'POST',
      url: '/api/usage/backfill',
      payload: { utcOffsetMinutes: 0 },
    });
    assert.deepEqual(body(repeated), { backfilled: true, skipped: true });

    const usage = await app.inject({ method: 'GET', url: '/api/usage?days=1' });
    const payload = body<{
      items: Array<{ estimated: boolean; requests: number; input: number; output: number }>;
      estimated: { total: number; requests: number };
      backfilled: boolean;
    }>(usage);
    assert.equal(payload.backfilled, true);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].estimated, true);
    assert.equal(payload.items[0].requests, 1);
    assert.ok(payload.estimated.total > 0);
  });
});
