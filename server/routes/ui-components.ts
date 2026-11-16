import type { FastifyInstance } from 'fastify';

import type { UiComponentService } from '../services/ui-components';
import { AppError } from '../errors';
import { hasFeature } from '../features/registry';
import {
  baseRevisionQuerySchema,
  bindingIdSchema,
  bindingStateSchema,
  commandIdSchema,
  commandResultSchema,
  componentIdSchema,
  createComponentSchema,
  listComponentsQuerySchema,
  patchComponentSchema,
  publishComponentSchema,
  versionParamSchema,
} from './ui-component-schemas';

export type UiComponentRouteDeps = { ui: UiComponentService };

function pathParam(params: unknown, name: string): string {
  return String((params as Record<string, unknown>)[name]);
}

function requireFeature(): void {
  if (!hasFeature('ui_workshop')) {
    throw new AppError(403, 'feature_unavailable', '当前实例尚未开放 UI 工坊。');
  }
}

export function registerUiComponentRoutes(app: FastifyInstance, deps: UiComponentRouteDeps): void {
  const { ui } = deps;

  app.get('/api/ui/components', async (request) => {
    requireFeature();
    const query = listComponentsQuerySchema.parse(request.query);
    return { items: ui.list({ ...(query.q ? { query: query.q } : {}) }) };
  });

  app.post('/api/ui/components', async (request, reply) => {
    requireFeature();
    const payload = createComponentSchema.parse(request.body);
    const created = ui.create(payload);
    reply.code(201);
    return created;
  });

  app.get('/api/ui/components/:componentId', async (request) => {
    requireFeature();
    const componentId = componentIdSchema.parse(pathParam(request.params, 'componentId'));
    return ui.detail(componentId);
  });

  app.patch('/api/ui/components/:componentId', async (request) => {
    requireFeature();
    const componentId = componentIdSchema.parse(pathParam(request.params, 'componentId'));
    const payload = patchComponentSchema.parse(request.body);
    return ui.patch(componentId, {
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
    }, payload.baseRevision);
  });

  app.delete('/api/ui/components/:componentId', async (request) => {
    requireFeature();
    const componentId = componentIdSchema.parse(pathParam(request.params, 'componentId'));
    const query = baseRevisionQuerySchema.parse(request.query);
    ui.archive(componentId, query.baseRevision);
    return { ok: true };
  });

  app.post('/api/ui/components/:componentId/publish', async (request) => {
    requireFeature();
    const componentId = componentIdSchema.parse(pathParam(request.params, 'componentId'));
    const payload = publishComponentSchema.parse(request.body);
    return ui.publish(componentId, payload.version, payload.baseRevision);
  });

  app.get('/api/ui/components/:componentId/latest', async (request) => {
    requireFeature();
    const componentId = componentIdSchema.parse(pathParam(request.params, 'componentId'));
    return { version: ui.latestContent(componentId) };
  });

  app.get('/api/ui/components/:componentId/versions/:version', async (request) => {
    requireFeature();
    const componentId = componentIdSchema.parse(pathParam(request.params, 'componentId'));
    const version = versionParamSchema.parse(pathParam(request.params, 'version'));
    return { version: ui.versionContent(componentId, version) };
  });

  app.get('/api/ui/bindings/:bindingId', async (request) => {
    requireFeature();
    const bindingId = bindingIdSchema.parse(pathParam(request.params, 'bindingId'));
    return { binding: ui.bindingSnapshot(bindingId) };
  });

  app.post('/api/ui/bindings/:bindingId/state', async (request) => {
    requireFeature();
    const bindingId = bindingIdSchema.parse(pathParam(request.params, 'bindingId'));
    const payload = bindingStateSchema.parse(request.body);
    return ui.saveBindingState(bindingId, payload.state, payload.baseRevision);
  });

  app.post('/api/ui/bindings/:bindingId/commands/:commandId/result', async (request) => {
    requireFeature();
    const bindingId = bindingIdSchema.parse(pathParam(request.params, 'bindingId'));
    const commandId = commandIdSchema.parse(pathParam(request.params, 'commandId'));
    const payload = commandResultSchema.parse(request.body);
    return ui.commandResult(bindingId, commandId, {
      ...payload,
      ...(payload.error !== undefined ? { error: payload.error } : {}),
    });
  });
}
