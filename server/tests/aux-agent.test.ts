import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import { normalizeMemorySummary } from '../agent/memory';
import { normalizeConversationTitle } from '../agent/title';

const MODEL = {
  id: 'model-1',
  name: 'Test model',
  modelId: 'test-model',
  providerId: 'provider-1',
  providerName: 'Provider',
  protocol: 'completion',
  baseUrl: 'https://api.example.com/v1',
  requiresApiKey: true,
  supportsImage: false,
  contextWindow: 128_000,
  maxOutput: 4_096,
};

async function withApp(fn: (ctx: Awaited<ReturnType<typeof buildApp>>) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-aux-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const ctx = await buildApp({ settings });
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('conversation titles and memory summaries are normalized', () => {
  assert.equal(normalizeConversationTitle('## "测试标题"'), '测试标题');
  assert.equal(normalizeConversationTitle('Title: Hello world from the test'), 'Hello world from the test');
  assert.equal(normalizeConversationTitle('   '), null);
  assert.equal(normalizeMemorySummary('<memory>\n# User\n- Likes TypeScript\n</memory>'), '# User\n- Likes TypeScript');
  assert.equal(normalizeMemorySummary('```markdown\n# Memory\n```'), '# Memory');
});

test('title and memory endpoints return null without a configured API key', async () => {
  await withApp(async (ctx) => {
    const title = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/title',
      payload: { model: MODEL, content: 'Generate a title' },
    });
    assert.equal(title.statusCode, 200);
    assert.deepEqual(title.json(), { title: null });

    const memory = await ctx.app.inject({
      method: 'POST',
      url: '/api/agent/memory',
      payload: {
        model: MODEL,
        currentSummary: '',
        userMessage: 'Remember that I use TypeScript',
        assistantMessage: 'Noted.',
      },
    });
    assert.equal(memory.statusCode, 200);
    assert.deepEqual(memory.json(), { summary: null });
  });
});
