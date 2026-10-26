import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, createAdminSession, createAuthSession } from '../src/core/api/auth-session.ts';
import { hasFeature } from '../src/core/features/capabilities.ts';
import { visibleSettings } from '../src/features/settings/settings-catalog.ts';

const account = (id, features = []) => ({ id, username: id, isAdmin: false, mustChangePassword: false, features });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function storage(initial = null) {
  let value = initial;
  return { read: () => value, write: (next) => { value = next; } };
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test('tool request cancellation stays an AbortError and retry-after survives HTTP errors', async () => {
  const controller = new AbortController();
  const auth = createAuthSession(storage(), async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }));
  const pending = auth.request('/api/tools/fetch', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  const busy = createAuthSession(storage(), async () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Busy' } }), {
    status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
  }));
  await assert.rejects(busy.request('/api/tools/search'), (error) => error instanceof ApiError && error.retryAfterMs === 5000);
});

test('restoring a token hides features until the server validates the account', async () => {
  const gate = deferred();
  const store = storage('token');
  const auth = createAuthSession(store, async (url, init) => {
    assert.equal(url, '/api/auth/me');
    assert.equal(init.headers.get('Authorization'), 'Bearer token');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    return gate.promise;
  });
  const pending = auth.refresh();
  assert.equal(hasFeature(auth.getSnapshot().user, 'labs'), false);
  gate.resolve(response(account('admin_test', ['labs'])));
  await pending;
  assert.equal(hasFeature(auth.getSnapshot().user, 'labs'), true);
});

test('account switching and logout reject stale login results', async () => {
  const preview = deferred();
  const store = storage();
  const auth = createAuthSession(store, async (url, init) => {
    if (url.endsWith('/logout')) return response({ ok: true });
    const { username } = JSON.parse(init.body);
    return username === 'admin_test' ? preview.promise : response({ token: 'regular-token', user: account('regular') });
  });
  const first = auth.login('admin_test', 'password');
  const regular = await auth.login('regular', 'password');
  preview.resolve(response({ token: 'preview-token', user: account('admin_test', ['labs']) }));
  assert.equal(await first, undefined, 'a superseded login must not hand the caller a stale account');
  assert.equal(regular.id, 'regular', 'a successful login returns the authenticated account');
  assert.equal(auth.getSnapshot().user.id, 'regular');
  assert.equal(store.read(), 'regular-token');
  await auth.logout();
  assert.equal(auth.getSnapshot().user, null);
  assert.equal(store.read(), null);
});

test('network errors hide entitlements; expired tokens are cleared', async () => {
  let mode = 'ok';
  const store = storage('token');
  const auth = createAuthSession(store, async () => {
    if (mode === 'offline') throw new Error('network internals must not leak');
    if (mode === 'expired') return response({ error: { code: 'unauthorized', message: '请重新登录。' } }, 401);
    return response(account('admin_test', ['labs']));
  });
  await auth.refresh();
  mode = 'offline';
  await auth.refresh();
  assert.equal(auth.getSnapshot().user, null);
  assert.equal(auth.getSnapshot().status, 'unavailable');
  assert.equal(store.read(), 'token');
  assert(!auth.getSnapshot().error.includes('internals'));
  mode = 'expired';
  await auth.refresh();
  assert.equal(auth.getSnapshot().status, 'anonymous');
  assert.equal(store.read(), null);
});

test('an older unauthorized response cannot log out a newly authenticated account', async () => {
  const old = deferred();
  const auth = createAuthSession(storage('old-token'), async (url) => url.endsWith('/me')
    ? old.promise : response({ token: 'new-token', user: account('regular') }));
  const refresh = auth.refresh();
  await auth.login('regular', 'password');
  old.resolve(response({ error: { code: 'unauthorized', message: 'expired' } }, 401));
  await refresh;
  assert.equal(auth.getSnapshot().user.id, 'regular');
});

test('catalogue and capability checks hide preview features for ordinary/anonymous/Mock users', () => {
  assert(!visibleSettings([]).some((item) => item.id === 'labs'));
  assert(visibleSettings(['labs']).some((item) => item.id === 'labs'));
  assert(!visibleSettings(['labs'], true).some((item) => ['labs', 'account'].includes(item.id)));
  assert.equal(hasFeature({ ...account('admin_test', ['labs']), mustChangePassword: true }, 'labs'), false);
  assert.equal(hasFeature(account('admin_test'), 'labs'), false, 'a client-side username grants nothing');
  assert.equal(hasFeature({ ...account('admin'), isAdmin: true }, 'labs'), false);
});

test('the account category belongs to its own group', () => {
  const anonymous = visibleSettings([], false, false);
  const authenticated = visibleSettings([], false, true);
  assert(anonymous.some((item) => item.id === 'account'));
  assert(!anonymous.some((item) => item.id === 'sync'), 'legacy sync must not appear as a settings category');
  assert.equal(authenticated.find((item) => item.id === 'account')?.group, '账号');
  assert(!authenticated.some((item) => item.id === 'sync'));
  assert(!authenticated.some((item) => item.group === '应用' && item.id === 'account'));
  assert(!visibleSettings([], true, true).some((item) => item.id === 'account'));
});

test('admin sessions use admin-scoped endpoints and never touch the user session', async () => {
  const store = storage();
  const calls = [];
  const auth = createAdminSession(store, async (url, init) => {
    calls.push(url);
    if (url === '/api/admin/auth/login') {
      return response({ token: 'admin-token', user: { ...account('admin'), isAdmin: true } });
    }
    assert.equal(init.headers.get('Authorization'), 'Bearer admin-token');
    return response({ password: 'bob@123' }, 201);
  });
  await auth.login('admin', 'password');
  assert.equal(store.read(), 'admin-token');
  const created = await auth.request('/api/admin/users', { method: 'POST', body: '{"username":"bob"}' });
  assert.deepEqual(created, { password: 'bob@123' });
  assert.deepEqual(calls, ['/api/admin/auth/login', '/api/admin/users']);
});

test('changing the initial password refreshes capabilities without storing credentials', async () => {
  const store = storage();
  const calls = [];
  const auth = createAuthSession(store, async (url, init) => {
    calls.push(url);
    if (url.endsWith('/login')) return response({ token: 'session-only', user: {
      ...account('admin_test'), mustChangePassword: true,
    } });
    assert.equal(init.headers.get('Authorization'), 'Bearer session-only');
    if (url.endsWith('/change-password')) return response({ ok: true });
    return response(account('admin_test', ['labs']));
  });
  await auth.login('admin_test', 'initial-password');
  assert.equal(hasFeature(auth.getSnapshot().user, 'labs'), false);
  await auth.changePassword('initial-password', 'replacement-password');
  assert.equal(hasFeature(auth.getSnapshot().user, 'labs'), true);
  assert.deepEqual(calls, ['/api/auth/login', '/api/auth/change-password', '/api/auth/me']);
  assert.equal(store.read(), 'session-only');
  assert(!JSON.stringify(auth.getSnapshot()).includes('password'));
});
