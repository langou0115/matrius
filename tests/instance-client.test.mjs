import assert from 'node:assert/strict';
import test from 'node:test';
import { createInstanceClient, ApiError } from '../ui/core/api/instance-client.ts';
import { visibleSettings } from '../ui/features/settings/settings-catalog.ts';
import { workspaceScope } from '../ui/features/workspace/workspace-mode.ts';

test('instance connects with same-origin credentials and loads capabilities', async () => {
  const client = createInstanceClient(async (url, init) => {
    assert.equal(url, '/api/features');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers.has('Authorization'), false);
    return Response.json({ features: [{ id: 'files' }, { id: 'usage' }] });
  });
  await client.refresh();
  assert.deepEqual(client.getSnapshot().info.features, ['files', 'usage']);
  assert.equal(client.getSnapshot().authRequired, false);
  assert.equal(workspaceScope(client.getSnapshot(), false), 'instance');
});

test('401 transitions instance to locked and unlock restores ready state', async () => {
  let locked = true;
  const client = createInstanceClient(async (url, init) => {
    if (url === '/api/features') {
      if (locked) return Response.json({ error: { code: 'auth_required', message: 'locked' } }, { status: 401 });
      return new Response(JSON.stringify({ features: [{ id: 'files' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Matrius-Auth': 'required' },
      });
    }
    if (url === '/api/auth/unlock') {
      const body = JSON.parse(String(init.body));
      if (body.secret !== 'good-secret') {
        return Response.json({ error: { code: 'invalid_secret', message: '访问密钥不正确。' } }, { status: 401 });
      }
      locked = false;
      return Response.json({ ok: true, unlocked: true });
    }
    if (url === '/api/auth/lock') {
      locked = true;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  await client.refresh();
  assert.equal(client.getSnapshot().status, 'locked');
  assert.equal(client.getSnapshot().authRequired, true);

  await assert.rejects(() => client.unlock('wrong'), (err) => err instanceof ApiError && err.status === 401);
  assert.equal(client.getSnapshot().status, 'locked');

  await client.unlock('good-secret');
  assert.equal(client.getSnapshot().status, 'ready');
  assert.equal(client.getSnapshot().authRequired, true);

  await client.lock();
  assert.equal(client.getSnapshot().status, 'locked');
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

test('204 No Content responses resolve cleanly without JSON parse error', async () => {
  const client = createInstanceClient(async () => new Response(null, { status: 204 }));
  const result = await client.request('/api/tasks/task-1', { method: 'DELETE' });
  assert.equal(result, undefined);
});

test('resource settings contain storage and usage without an account category', () => {
  const items = visibleSettings(['files', 'usage'], false, true);
  assert.equal(items.find(i => i.id === 'storage').group, '资源');
  assert.equal(items.find(i => i.id === 'usage').group, '资源');
  assert.equal(items.some(i => i.id === 'account'), false);
});
