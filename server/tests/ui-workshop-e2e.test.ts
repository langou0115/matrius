import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp, type AppDependencies } from '../app';
import { loadSettings } from '../config';

function completionChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-fake',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fake-model',
    ...payload,
  })}\n\n`;
}

function textChunk(content: string, finishReason: string | null): string {
  return completionChunk({
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  });
}

function toolCallChunk(name: string, args: unknown): string {
  return completionChunk({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  });
}

async function fakeToolProvider(toolArgs: {
  name: string;
  args: unknown;
}): Promise<{ url: string; calls: () => number; close: () => Promise<void> }> {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (calls === 1) {
      response.write(toolCallChunk(toolArgs.name, toolArgs.args));
      response.write(textChunk('', 'tool_calls'));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(textChunk('已经用任务看板渲染了这些任务。', null));
    response.write(textChunk('', 'stop'));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fake provider did not bind.');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    calls: () => calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function withApp(fn: (ctx: { baseUrl: string; deps: AppDependencies }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'matrius-ui-workshop-e2e-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const { app, deps } = await buildApp({ settings });
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('App did not bind.');
    await fn({ baseUrl: `http://127.0.0.1:${address.port}`, deps });
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

test('a workshop run writes a new component version and reports the change', async () => {
  await withApp(async ({ baseUrl, deps }) => {
    const created = deps.ui.create({ name: '中国象棋', stateful: true });
    const provider = await fakeToolProvider({
      name: 'ui_component',
      args: {
        action: 'update',
        name: '中国象棋',
        description: '可以下一局的棋盘',
        html: '<script>function render(root, ctx){root.textContent = ctx.state ? "board" : "new";}</script>',
        inputSchema: { type: 'object', properties: {} },
        stateSchema: { type: 'object', properties: { turn: { type: 'string' } } },
        commands: [{ name: 'move' }],
      },
    });
    try {
      const response = await fetch(`${baseUrl}/api/agent/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          conversationId: created.conversationId,
          replyId: 'e2e-workshop-reply',
          model: model(provider.url),
          messages: [{ id: 'user-1', role: 'user', content: '做一个中国象棋棋盘，记得保存局面' }],
          tools: { web: false, files: false, ui: true },
          scope: 'workshop',
          uiComponentId: created.component.id,
        }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.match(stream, /"uiComponentChange":\{/u);
      assert.match(stream, /"action":"update"/u);
      assert.match(stream, /"name":"中国象棋"/u);
      assert.match(stream, /"status":"complete"/u);

      const detail = deps.ui.detail(created.component.id);
      assert.equal(detail.component.currentVersion, 1);
      assert.equal(detail.versions.length, 1);
      assert.equal(detail.versions[0].status, 'draft');
      const content = deps.ui.latestContent(created.component.id);
      assert.equal(content.commands.length, 1);
      assert.ok(content.stateSchema, 'the state schema is stored with the version');
      assert.equal(deps.ui.hasPublished(), false);
    } finally {
      await provider.close();
    }
  });
});

test('a chat run renders a published component through the ui_component tool', async () => {
  await withApp(async ({ baseUrl, deps }) => {
    const { component } = deps.ui.create({ name: '任务看板' });
    const saved = deps.ui.saveVersion(component.id, {
      name: '任务看板',
      html: '<script>function render(root, ctx){root.textContent = ctx.props.tasks.length + " tasks";}</script>',
      inputSchema: { type: 'object', properties: { tasks: { type: 'array' } } },
      stateSchema: null,
    });
    deps.ui.publish(component.id, 1, saved.component.revision);

    const provider = await fakeToolProvider({
      name: 'ui_component',
      args: {
        action: 'render',
        componentId: component.id,
        props: { tasks: [{ name: '登录页' }] },
      },
    });
    try {
      const response = await fetch(`${baseUrl}/api/agent/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          conversationId: 'e2e-ui-conversation',
          replyId: 'e2e-ui-reply',
          model: model(provider.url),
          messages: [{ id: 'user-1', role: 'user', content: '用任务看板展示这些任务' }],
          tools: { web: false, files: false, ui: true },
        }),
      });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.equal(provider.calls(), 2, 'the tool result goes back to the model');
      assert.match(stream, /event: run/u);
      assert.match(stream, /"uiComponents":\[/u);
      assert.match(stream, new RegExp(`"componentId":"${component.id}"`, 'u'));
      assert.match(stream, /"version":1/u);
      assert.match(stream, /"name":"任务看板"/u);
      assert.match(stream, /"props":\{"tasks":\[\{"name":"登录页"\}\]\}/u);
      assert.match(stream, /已经用任务看板渲染了这些任务。/u);
      assert.match(stream, /event: end/u);
      assert.match(stream, /"status":"complete"/u);
    } finally {
      await provider.close();
    }
  });
});
