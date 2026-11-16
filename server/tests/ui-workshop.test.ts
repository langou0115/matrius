import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildApp } from '../app';
import { loadSettings } from '../config';
import type { AppDependencies } from '../app';
import { createToolActivityResolver } from '../agent/tool-activity';
import { toolRegistry } from '../agent/tools';
import type { ToolContext } from '../agent/tools/types';
import { featureIds } from '../features/registry';

type Json = Record<string, unknown>;
type ComponentJson = {
  id: string;
  status: string;
  currentVersion: number;
  publishedVersion: number | null;
  stateful: boolean;
  conversationId: string | null;
  revision: number;
};
type Ctx = { app: Awaited<ReturnType<typeof buildApp>>['app']; deps: AppDependencies };

async function withApp(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'matrius-ui-workshop-'));
  const settings = loadSettings({ APP_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'silent' });
  const { app, deps } = await buildApp({ settings });
  try {
    await fn({ app, deps });
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function body<T = Json>(response: { json: () => unknown }): T {
  return response.json() as T;
}

async function createComponent(ctx: Ctx, name = '项目进度看板', stateful = false): Promise<{ component: ComponentJson; conversationId: string }> {
  const response = await ctx.app.inject({ method: 'POST', url: '/api/ui/components', payload: { name, stateful } });
  assert.equal(response.statusCode, 201, response.body);
  return body<{ component: ComponentJson; conversationId: string }>(response);
}

const progressSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, owner: { type: 'string' } },
      },
    },
  },
};

const progressHtml = '<style>.card{color:var(--matrius-foreground)}</style><script>function render(root, ctx){root.textContent = ctx.props.tasks.length + " tasks";}</script>';

test('component lifecycle: draft versions, publish pointer and the chat catalog', async () => {
  await withApp(async (ctx) => {
    const created = await createComponent(ctx);
    const component = created.component;
    assert.equal(component.status, 'draft');
    assert.equal(component.currentVersion, 0);
    assert.equal(component.publishedVersion, null);
    assert.equal(component.stateful, false);
    assert.match(String(component.conversationId), /^[0-9a-f-]{36}$/u);
    // The workshop session is a conversation, but it must stay out of the chat sidebar.
    const chatList = await ctx.app.inject({ method: 'GET', url: '/api/conversations' });
    assert.deepEqual(body<{ items: Json[] }>(chatList).items, []);

    const saved = ctx.deps.ui.saveVersion(String(component.id), {
      name: '项目进度看板',
      description: '任务、负责人、进度',
      html: progressHtml,
      inputSchema: progressSchema,
    });
    assert.equal(saved.content.version, 1);
    assert.equal(saved.content.status, 'draft');
    assert.equal(saved.change.action, 'update');
    assert.throws(
      () => ctx.deps.ui.saveVersion(String(component.id), { html: progressHtml, stateSchema: { type: 'object' } }),
      /展示型/u,
    );

    // Draft-only components cannot be rendered in chat.
    assert.throws(() => ctx.deps.ui.renderable(String(component.id)), /还没有发布/u);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/ui/components/${String(component.id)}` });
    assert.equal(detail.statusCode, 200);
    const detailBody = body<{ component: ComponentJson; versions: Json[] }>(detail);
    assert.equal(detailBody.versions.length, 1);
    assert.equal(detailBody.versions[0].status, 'draft');

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/ui/components/${String(component.id)}/publish`,
      payload: { version: 1, baseRevision: saved.component.revision },
    });
    assert.equal(published.statusCode, 200, published.body);
    assert.equal(body<{ component: Json }>(published).component.publishedVersion, 1);

    const resolved = ctx.deps.ui.renderable(String(component.id));
    assert.equal(resolved.content.version, 1);
    assert.throws(() => ctx.deps.ui.validateProps(resolved.content, { tasks: 'nope' }), /Schema/u);
    ctx.deps.ui.validateProps(resolved.content, { tasks: [{ name: '登录页' }] });

    assert.match(ctx.deps.ui.catalogText(), /项目进度看板/u);
    assert.equal(ctx.deps.ui.hasPublished(), true);

    // A later edit stays a draft and does not move the published pointer.
    const second = ctx.deps.ui.saveVersion(String(component.id), {
      html: progressHtml.replace('tasks.length', 'ctx.props.tasks.length'),
      inputSchema: progressSchema,
    });
    assert.equal(second.content.version, 2);
    assert.equal(second.content.status, 'draft');
    assert.equal(ctx.deps.ui.renderable(String(component.id)).content.version, 1);
  });
});

test('stateful bindings: schema-guarded state and declared commands', async () => {
  await withApp(async (ctx) => {
    const created = await createComponent(ctx, '中国象棋', true);
    const componentId = String(created.component.id);
    const conversationId = String(created.component.conversationId);
    assert.equal(created.component.stateful, true);

    assert.throws(
      () => ctx.deps.ui.saveVersion(componentId, { html: '<div>board</div>' }),
      /stateSchema/u,
    );

    const saved = ctx.deps.ui.saveVersion(componentId, {
      name: '中国象棋',
      description: '会记录局面的棋盘',
      html: '<script>function render(root, ctx){root.textContent = ctx.state ? ctx.state.turn : "new";} function onCommand(name, payload, ctx){return {ok:true, state:{turn:"white"}};}</script>',
      inputSchema: { type: 'object', properties: {} },
      stateSchema: {
        type: 'object',
        required: ['turn'],
        properties: { turn: { type: 'string' } },
      },
      commands: [{ name: 'move' }, { name: 'reset' }],
    });
    assert.equal(saved.content.commands.length, 2);

    const published = await ctx.app.inject({
      method: 'POST',
      url: `/api/ui/components/${componentId}/publish`,
      payload: { version: 1, baseRevision: saved.component.revision },
    });
    assert.equal(published.statusCode, 200, published.body);

    const opened = ctx.deps.ui.openBinding({
      conversationId,
      componentId,
      props: {},
    });
    const bindingId = opened.snapshot.id;
    assert.equal(opened.snapshot.state, null);
    assert.equal(opened.snapshot.version, 1);
    assert.deepEqual(opened.snapshot.props, {});

    const updated = ctx.deps.ui.saveBindingState(bindingId, { turn: 'white' }, opened.snapshot.revision);
    assert.equal(updated.revision, 2);
    assert.throws(() => ctx.deps.ui.saveBindingState(bindingId, { turn: 3 }, 2), /stateSchema/u);
    assert.throws(() => ctx.deps.ui.saveBindingState(bindingId, { turn: 'black' }, 1), /别处更新/u);

    const queued = ctx.deps.ui.enqueueCommand({ bindingId, name: 'move', payload: { from: 'g1', to: 'f3' } });
    assert.equal(queued.command.status, 'pending');
    assert.equal(ctx.deps.ui.bindingSnapshot(bindingId).pendingCommands.length, 1);
    assert.throws(() => ctx.deps.ui.enqueueCommand({ bindingId, name: 'teleport', payload: {} }), /没有声明/u);

    const result = ctx.deps.ui.commandResult(bindingId, String(queued.command.id), {
      ok: true,
      state: { turn: 'black' },
      baseRevision: 2,
    });
    assert.equal(result.status, 'applied');
    assert.equal(result.revision, 3);
    const snapshot = ctx.deps.ui.bindingSnapshot(bindingId);
    assert.deepEqual(snapshot.state, { turn: 'black' });
    assert.deepEqual(snapshot.pendingCommands, []);

    // A failed command is recorded without touching the state.
    const failed = ctx.deps.ui.enqueueCommand({ bindingId, name: 'reset', payload: {} });
    const failedResult = ctx.deps.ui.commandResult(bindingId, String(failed.command.id), { ok: false, error: '这步不合法' });
    assert.equal(failedResult.status, 'failed');
    assert.deepEqual(ctx.deps.ui.bindingSnapshot(bindingId).state, { turn: 'black' });
  });
});

test('website UI component artifacts are persisted with the message', async () => {
  await withApp(async (ctx) => {
    const created = await createComponent(ctx, '销售图表');
    const componentId = String(created.component.id);
    const conversationId = String(created.component.conversationId);
    const artifact = { componentId, version: 1, name: '销售图表', props: { points: [1, 2, 3] } };

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: {
        clientId: `artifact-${Date.now()}`,
        role: 'assistant',
        content: '已渲染图表。',
        status: 'complete',
        uiComponents: [artifact],
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const stored = body<{ uiComponents: Json[] }>(response);
    assert.equal(stored.uiComponents.length, 1);
    assert.deepEqual(stored.uiComponents[0], artifact);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}?messageLimit=10` });
    const messages = body<{ messages: Json[] }>(detail).messages;
    assert.deepEqual(messages[0].uiComponents, [artifact]);
  });
});

test('the ui_component tool renders published components and refuses authoring in chat', async () => {
  await withApp(async (ctx) => {
    const created = await createComponent(ctx, '任务看板');
    const componentId = String(created.component.id);
    const saved = ctx.deps.ui.saveVersion(componentId, {
      name: '任务看板',
      html: '<script>function render(root, ctx){root.textContent = "ok";}</script>',
      inputSchema: { type: 'object', properties: { tasks: { type: 'array' } } },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/ui/components/${componentId}/publish`,
      payload: { version: 1, baseRevision: saved.component.revision },
    });

    const module = toolRegistry.get('ui_component');
    assert.ok(module, 'the tool is registered');
    const context = {
      instanceId: 1,
      conversationId: String(created.component.conversationId),
      features: new Set(featureIds()),
      services: { search: {} as never, fetch: {} as never, ui: ctx.deps.ui },
      scope: 'chat',
    } satisfies ToolContext;
    const tool = module.create(context);

    const rendered = await tool.execute(
      'call-render',
      { action: 'render', componentId, props: { tasks: [] } },
      undefined as never,
    );
    assert.deepEqual((rendered.details as { artifact?: unknown }).artifact, {
      componentId,
      version: 1,
      name: '任务看板',
      props: { tasks: [] },
    });
    const resolver = createToolActivityResolver(toolRegistry);
    assert.equal(resolver.uiComponents(rendered).length, 1);
    assert.equal(resolver.uiComponentChange(rendered), null);

    const listed = await tool.execute('call-list', { action: 'list' }, undefined as never);
    assert.match((listed.content[0] as { text: string }).text, /任务看板/u);

    await assert.rejects(
      tool.execute('call-update', { action: 'update', html: '<div>x</div>' }, undefined as never),
      /只有 UI 工坊/u,
    );
  });
});

test('archiving hides a component from chat and cannot be rendered', async () => {
  await withApp(async (ctx) => {
    const created = await createComponent(ctx, '临时组件');
    const componentId = String(created.component.id);
    const saved = ctx.deps.ui.saveVersion(componentId, {
      html: '<script>function render(root){root.textContent="x"}</script>',
      inputSchema: { type: 'object', properties: {} },
    });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/ui/components/${componentId}/publish`,
      payload: { version: 1, baseRevision: saved.component.revision },
    });
    const detail = await ctx.app.inject({ method: 'GET', url: `/api/ui/components/${componentId}` });
    const revision = body<{ component: { revision: number } }>(detail).component.revision;

    const archived = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/ui/components/${componentId}?baseRevision=${revision}`,
    });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.throws(() => ctx.deps.ui.renderable(componentId), /已归档/u);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/ui/components' });
    assert.deepEqual(body<{ items: Json[] }>(list).items, []);
    assert.equal(ctx.deps.ui.hasPublished(), false);
  });
});
