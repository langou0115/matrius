import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import { createReplyRun } from '../agent/src/core/runner.ts';
import { createUiTools } from '../agent/src/ui-tools.ts';
import { readUiArtifacts } from '../agent/src/core/ui-contract.ts';
import { sandboxDocument } from '../src/features/copilot/ui-artifacts.tsx';
import { parseWorkspace } from '../src/features/workspace/workspace-repository.ts';

const config = { id: 'test', name: 'Test', modelId: 'test-model', protocol: 'completion', providerId: 'test', providerName: 'Test', baseUrl: 'https://test.invalid/v1', contextWindow: 128000, maxOutput: 4096, requiresApiKey: false, supportsImage: false };
const props = { title: 'Options', columns: ['A', 'B'], rows: [['1', '2']] };
function response(content, stopReason) {
  const message = { role: 'assistant', content, stopReason, api: 'openai-completions', provider: 'test', model: 'test-model', timestamp: Date.now(), usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: stopReason, message });
  return stream;
}

test('model UI tool execution emits a persisted snapshot and permits a UI-only final answer', async () => {
  const updates = [], events = [];
  let round = 0;
  const run = createReplyRun({ config, apiKey: '', messages: [{ id: 'user', role: 'user', content: 'Compare' }], tools: createUiTools(),
    onUpdate: value => updates.push(value), onToolEvent: event => events.push(event),
    streamFn: () => ++round === 1 ? response([{ type: 'toolCall', id: 'table-call', name: 'comparisonTable', arguments: props }], 'toolUse') : response([], 'stop'),
  });
  assert.equal((await run.start()).status, 'complete');
  assert.deepEqual(updates.at(-1).uiArtifacts, [{ id: 'table-call', name: 'comparisonTable', props }]);
  assert.ok(updates.some(update => update.uiArtifacts?.some(item => item.streaming)), 'UI previews arrive before tool completion');
  assert.deepEqual(events.map(event => event.type), ['start', 'end']);
});

test('workspace reload keeps UI snapshots and discards malformed artifacts', () => {
  const artifact = { id: 'table-call', name: 'comparisonTable', props };
  const restored = parseWorkspace({ schemaVersion: 1, appearance: { themeId: 'twitter', mode: 'system' }, chat: { activeId: 'chat', sidebarOpen: true, conversations: [{ id: 'chat', title: 'Test', updatedAt: 1, pinned: false, messages: [{ id: 'reply', role: 'assistant', content: '', uiArtifacts: [artifact] }] }] } });
  assert.deepEqual(restored.data.chat.conversations[0].messages[0].uiArtifacts, [artifact]);
  assert.equal(readUiArtifacts([{ ...artifact, name: '__proto__' }]), undefined);
  assert.equal(readUiArtifacts([{ ...artifact, props: {} }]), undefined);
});

test('text before a UI call stays before the UI when the model continues its answer', async () => {
  const updates = [];
  let round = 0;
  const run = createReplyRun({ config, apiKey: '', messages: [{ id: 'user', role: 'user', content: 'Compare' }], tools: createUiTools(), onUpdate: value => updates.push(value),
    streamFn: () => ++round === 1 ? response([{ type: 'text', text: 'Before' }, { type: 'toolCall', id: 'ordered-ui', name: 'comparisonTable', arguments: props }], 'toolUse') : response([{ type: 'text', text: 'After' }], 'stop'),
  });
  assert.equal((await run.start()).status, 'complete');
  assert.equal(updates.at(-1).content, 'Before\n\nAfter');
  assert.equal(updates.at(-1).uiArtifacts[0].textOffset, 6);
});

test('generated document forbids network, host storage and external frames and escapes script terminators', () => {
  const html = sandboxDocument({ initialHeight: 300, placeholderMessages: [], css: '', html: '<button>Calculate</button>', jsFunctions: 'const text="</script>";', jsExpressions: '' });
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /window\.matrius/);
  assert.equal((html.match(/<\/script>/g) ?? []).length, 1);
  const preview = sandboxDocument({ initialHeight: 300, placeholderMessages: [], css: '', html: '<script>bad()</script><p>Preview</p>', jsFunctions: 'bad()', jsExpressions: 'bad()' }, true);
  assert.match(preview, /script-src 'none'/);
  assert.doesNotMatch(preview, /window\.matrius/);
});
