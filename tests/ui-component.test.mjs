import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeUiComponentDocument,
  isUiComponentArtifact,
  summarizeSchema,
  uiComponentCatalogText,
  UI_COMPONENT_CSP,
} from '../contract/ui-component.ts';

test('the sandbox document blocks network and eval, and hosts the fragment', () => {
  const fragment = '<style>.x{color:red}</style><script>function render(root, ctx){root.textContent = "ok";}</script>';
  const document = composeUiComponentDocument(fragment);
  assert.ok(document.includes('<!DOCTYPE html>'));
  assert.ok(document.includes(UI_COMPONENT_CSP));
  assert.match(UI_COMPONENT_CSP, /connect-src 'none'/);
  assert.match(UI_COMPONENT_CSP, /default-src 'none'/);
  assert.ok(!/script-src[^;]*'unsafe-eval'/.test(UI_COMPONENT_CSP), 'eval must stay blocked');
  assert.ok(document.includes('<div id="root"></div>'), 'the host owns the root node');
  assert.ok(document.includes(fragment), 'the authored fragment is appended verbatim');
  assert.ok(document.includes('matrius:init'), 'the bridge expects the host init message');
  assert.ok(document.indexOf('window.MatriusUI =') < document.indexOf(fragment), 'the bridge is installed before the fragment runs');
});

test('artifacts are validated before they reach the message', () => {
  assert.equal(isUiComponentArtifact({ componentId: 'a', version: 1, name: '看板' }), true);
  assert.equal(isUiComponentArtifact({ componentId: 'a', version: 1, name: '看板', bindingId: 'b', commandIds: ['c'] }), true);
  assert.equal(isUiComponentArtifact({ componentId: '', version: 1, name: '看板' }), false);
  assert.equal(isUiComponentArtifact({ componentId: 'a', version: 0, name: '看板' }), false);
  assert.equal(isUiComponentArtifact({ componentId: 'a', version: 1, name: '' }), false);
  assert.equal(isUiComponentArtifact({ componentId: 'a', version: 1, name: '看板', commandIds: [42] }), false);
  assert.equal(isUiComponentArtifact(null), false);
});

test('the prompt catalog states the mode and the props fields', () => {
  const text = uiComponentCatalogText([
    {
      componentId: 'id-1',
      name: '项目看板',
      description: '展示任务',
      version: 3,
      inputSchema: {
        type: 'object',
        required: ['tasks'],
        properties: { tasks: { type: 'array' }, filter: { type: 'string' } },
      },
      stateful: false,
    },
    {
      componentId: 'id-2',
      name: '中国象棋',
      description: '',
      version: 1,
      inputSchema: { type: 'object', properties: {} },
      stateful: true,
    },
  ]);
  assert.match(text, /id-1 — 项目看板（第 3 版，展示型，用 render）/);
  assert.match(text, /props 字段：tasks\*, filter/);
  assert.match(text, /id-2 — 中国象棋（第 1 版，有状态，用 open\/command）/);
  assert.equal(uiComponentCatalogText([]), '');
  assert.equal(summarizeSchema({ type: 'object', properties: {} }), '');
});
