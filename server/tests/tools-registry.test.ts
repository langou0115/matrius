import assert from 'node:assert/strict';
import test from 'node:test';

import { Type } from 'typebox';

import { ToolRegistry } from '../tools/registry';
import type { FeatureId, ToolActivityAdapter, ToolContext, ToolModule } from '../tools/types';

const context = (features: FeatureId[] = []): ToolContext => ({
  instanceId: 1,
  features: new Set(features),
});

function module(id: string, feature?: FeatureId): ToolModule {
  return {
    id,
    ...(feature ? { feature } : {}),
    prompt: `${id} guidance`,
    create: () => ({
      name: id,
      label: id,
      description: `The ${id} tool.`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: id }], details: {} }),
    }),
  };
}

test('the registry filters by feature and preserves registration order', () => {
  const registry = new ToolRegistry([module('web_search'), module('file', 'files')]);
  assert.deepEqual(registry.createTools(context()).map((tool) => tool.name), ['web_search']);
  assert.deepEqual(registry.createTools(context(['files'])).map((tool) => tool.name), ['web_search', 'file']);
  assert.deepEqual(registry.prompts(new Set()), ['web_search guidance']);
  assert.deepEqual(registry.prompts(new Set(['files'])), ['web_search guidance', 'file guidance']);
});

test('duplicate ids are rejected', () => {
  const registry = new ToolRegistry([module('file', 'files')]);
  assert.throws(() => registry.register(module('file', 'files')), /Duplicate tool module/u);
  assert.throws(() => registry.register({ ...module(' '), id: ' ' }), /non-empty id/u);
});

test('activity adapters are looked up by AgentTool name', () => {
  const activity: ToolActivityAdapter = {
    start: (id) => ({ id, kind: 'search', status: 'running' }),
    end: (id) => ({ id, kind: 'search', status: 'complete' }),
  };
  const registry = new ToolRegistry([{ ...module('web_search'), activity }]);
  assert.equal(registry.activityFor('web_search'), activity);
  assert.equal(registry.activityFor('missing'), undefined);
  assert.equal(registry.size, 1);
});
