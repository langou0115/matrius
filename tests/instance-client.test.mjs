import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstanceClient, ApiError } from '../src/core/api/instance-client.ts';
import { visibleSettings } from '../src/features/settings/settings-catalog.ts';
import { workspaceScope } from '../src/features/workspace/workspace-mode.ts';

test('instance connects without cookies or authorization and loads capabilities', async () => {
  const client = createInstanceClient(async (url, init) => {
    assert.equal(url, '/api/features');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.headers.has('Authorization'), false);
    return Response.json({ features: [{ id: 'files' }, { id: 'usage' }] });
  });
  await client.refresh();
  assert.deepEqual(client.getSnapshot().info.features, ['files', 'usage']);
  assert.equal(workspaceScope(client.getSnapshot(), false), 'instance');
});

test('unreachable instance is retried without a login state', async () => {
  let failed = true;
  const client = createInstanceClient(async () => {
    if (failed) throw new Error('offline');
    return Response.json({ features: [] });
  });
  await client.refresh();
  assert.equal(client.getSnapshot().status, 'unavailable');
  failed = false;
  await client.refresh();
  assert.equal(client.getSnapshot().status, 'ready');
});

test('API cancellation and Retry-After preserve error details', async () => {
  const controller = new AbortController();
  const client = createInstanceClient(async (_, init) => {
    controller.abort();
    init.signal.throwIfAborted();
  });
  await assert.rejects(client.request('/api/tools/search', { signal: controller.signal }), { name: 'AbortError' });
  const busy = createInstanceClient(async () => Response.json({ error: { code: 'busy', message: 'Busy' } }, { status: 429, headers: { 'Retry-After': '2' } }));
  await assert.rejects(busy.request('/api/tools/search'), e => e instanceof ApiError && e.retryAfterMs === 2000);
});

test('resource settings contain storage and usage without an account category', () => {
  const items = visibleSettings(['files', 'usage'], false, true);
  assert.equal(items.find(i => i.id === 'storage').group, '资源');
  assert.equal(items.find(i => i.id === 'usage').group, '资源');
  assert.equal(items.some(i => i.id === 'account'), false);
});
