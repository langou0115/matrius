import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';

function completionChunk(content: string, finishReason: string | null, usage = false): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
    ...(usage ? { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } } : {}),
  })}\n\n`;
}

async function fakeProvider(content: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    response.write(completionChunk('', null));
    response.write(completionChunk(content, null));
    response.write(completionChunk('', 'stop', true));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake provider did not bind.');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function withApp(fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-agent-e2e-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const { app } = await buildApp({ settings });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('App did not bind.');
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const model = (url: string) => ({
  id: 'fake-model',
  name: 'Fake model',
  modelId: 'fake-model',
  providerId: 'fake-provider',
  providerName: 'Fake provider',
  protocol: 'completion',
  baseUrl: url,
  requiresApiKey: false,
  supportsImage: false,
  contextWindow: 32_000,
  maxOutput: 4_096,
});

test('the server Agent streams a real provider response over the SSE route', async () => {
  const provider = await fakeProvider('Hello from the fake provider');
  try {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          conversationId: 'e2e-conversation',
          replyId: 'e2e-reply',
          model: model(provider.url),
          messages: [{ id: 'user-1', role: 'user', content: 'Say hello' }],
          tools: { web: false, files: false },
        }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /event: run/u);
      assert.match(text, /Hello from the fake provider/u);
      assert.match(text, /"status":"complete"/u);
    });
  } finally {
    await provider.close();
  }
});

test('the memory endpoint extracts and normalizes a summary', async () => {
  const provider = await fakeProvider('<memory>\n# User\n- Likes TypeScript\n</memory>');
  try {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(provider.url),
          currentSummary: '',
          userMessage: 'Remember that I like TypeScript',
          assistantMessage: 'Noted.',
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { summary: '# User\n- Likes TypeScript' });
    });
  } finally {
    await provider.close();
  }
});

test('the title endpoint uses the server Agent and normalizes the result', async () => {
  const provider = await fakeProvider('## Fake title');
  try {
    await withApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/agent/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model(provider.url),
          content: 'Generate a title',
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { title: 'Fake title' });
    });
  } finally {
    await provider.close();
  }
});
