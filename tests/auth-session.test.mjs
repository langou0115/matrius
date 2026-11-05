import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, createAdminSession, createAuthSession } from '../src/core/api/auth-session.ts';
import { hasFeature } from '../src/core/features/capabilities.ts';
import { AUTH_RETRY_DELAYS_MS, createAuthRetry, retryDelay } from '../src/features/auth/auth-retry.ts';
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
  assert.equal(hasFeature(auth.getSnapshot().user, 'files'), false);
  gate.resolve(response(account('alice', ['files'])));
  await pending;
  assert.equal(hasFeature(auth.getSnapshot().user, 'files'), true);
});

test('account switching and logout reject stale login results', async () => {
  const slow = deferred();
  const store = storage();
  const auth = createAuthSession(store, async (url, init) => {
    if (url.endsWith('/logout')) return response({ ok: true });
    const { username } = JSON.parse(init.body);
    return username === 'slow' ? slow.promise : response({ token: 'regular-token', user: account('regular') });
  });
  const first = auth.login('slow', 'password');
  const regular = await auth.login('regular', 'password');
  slow.resolve(response({ token: 'slow-token', user: account('slow', ['files']) }));
  assert.equal(await first, undefined, 'a superseded login must not hand the caller a stale account');
  assert.equal(regular.id, 'regular', 'a successful login returns the authenticated account');
  assert.equal(auth.getSnapshot().user.id, 'regular');
  assert.equal(store.read(), 'regular-token');
  await auth.logout();
  assert.equal(auth.getSnapshot().user, null);
  assert.equal(store.read(), null);
});

test('a rejected login stays with the dialog instead of the shared account state', async () => {
  const auth = createAuthSession(storage(), async () => response({
    error: { code: 'unauthorized', message: '用户名或密码错误。' },
  }, 401));
  await assert.rejects(auth.login('alice', 'wrong-password'), /用户名或密码错误/);
  assert.equal(auth.getSnapshot().status, 'anonymous');
  assert.equal(auth.getSnapshot().user, null);
  assert.equal(auth.getSnapshot().error, null, 'the account page must not keep the login failure');
});

test('network errors hide entitlements; expired tokens are cleared', async () => {
  let mode = 'ok';
  const store = storage('token');
  const auth = createAuthSession(store, async () => {
    if (mode === 'offline') throw new Error('network internals must not leak');
    if (mode === 'expired') return response({ error: { code: 'unauthorized', message: '请重新登录。' } }, 401);
    return response(account('alice', ['files']));
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

test('capability checks trust the server feature list and nothing else', () => {
  assert.equal(hasFeature(account('alice', ['files']), 'files'), true);
  assert.equal(hasFeature({ ...account('alice', ['files']), mustChangePassword: true }, 'files'), false);
  assert.equal(hasFeature(account('admin'), 'files'), false, 'a username grants nothing');
  assert.equal(hasFeature({ ...account('admin'), isAdmin: true }, 'files'), false, 'the admin role grants nothing');
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

test('storage needs the files feature and a signed-in account', () => {
  const storage = (features, authenticated) => visibleSettings(features, false, authenticated).find((item) => item.id === 'storage');
  assert.equal(storage([], false), undefined, 'anonymous accounts get no storage category');
  assert.equal(storage(['files'], false), undefined, 'features require an authenticated session');
  assert.equal(storage([], true), undefined, 'the files feature is required');
  assert.equal(storage(['files'], true)?.group, '账号');
  assert.equal(storage(['files'], true)?.description.includes('已用空间'), true);
  assert.equal(visibleSettings(['files'], true, true).some((item) => item.id === 'storage'), false,
    'preview mode stays inside the mock settings catalogue');
});

test('admin sessions use admin-scoped cookie endpoints and never touch the user session', async () => {
  const store = storage();
  const calls = [];
  const auth = createAdminSession(store, async (url, init) => {
    calls.push(url);
    assert.equal(init.credentials, 'include');
    assert.equal(init.headers.get('Authorization'), null);
    if (url === '/api/admin/auth/login') {
      return response({ token: 'admin-token', user: { ...account('admin'), isAdmin: true } });
    }
    return response({ password: 'bob@123' }, 201);
  });
  await auth.login('admin', 'password');
  assert.equal(store.read(), null, 'the HttpOnly token must not be readable from JS');
  const created = await auth.request('/api/admin/users', { method: 'POST', body: '{"username":"bob"}' });
  assert.deepEqual(created, { password: 'bob@123' });
  assert.deepEqual(calls, ['/api/admin/auth/login', '/api/admin/users']);
});

test('cookie sessions restore through /me, log out through the server and treat a missing cookie as anonymous', async () => {
  const calls = [];
  let authenticated = false;
  const auth = createAuthSession(storage(), async (url, init) => {
    calls.push(url);
    assert.equal(init.credentials, 'include');
    assert.equal(init.headers.get('Authorization'), null);
    if (url === '/api/auth/logout') return response({ ok: true });
    return authenticated ? response(account('alice')) : response(
      { error: { code: 'unauthorized', message: '请重新登录。' } }, 401,
    );
  }, { cookieAuth: true });

  assert.equal(auth.getSnapshot().status, 'checking');
  await auth.refresh();
  assert.equal(auth.getSnapshot().status, 'anonymous');
  assert.equal(auth.getSnapshot().error, null, 'a first visit is not an error');

  authenticated = true;
  await auth.refresh();
  assert.equal(auth.getSnapshot().status, 'authenticated');
  assert.equal(auth.getSnapshot().user.id, 'alice');

  await auth.logout();
  assert.deepEqual(calls, ['/api/auth/me', '/api/auth/me', '/api/auth/logout']);
  assert.equal(auth.getSnapshot().status, 'anonymous');
});

test('changing the initial password refreshes capabilities without storing credentials', async () => {
  const store = storage();
  const calls = [];
  const auth = createAuthSession(store, async (url, init) => {
    calls.push(url);
    if (url.endsWith('/login')) return response({ token: 'session-only', user: {
      ...account('alice'), mustChangePassword: true,
    } });
    assert.equal(init.headers.get('Authorization'), 'Bearer session-only');
    if (url.endsWith('/change-password')) {
      assert.deepEqual(JSON.parse(init.body), { newPassword: 'replacement-password' });
      return response({ ok: true });
    }
    return response(account('alice', ['files']));
  });
  await auth.login('alice', 'initial-password');
  assert.equal(hasFeature(auth.getSnapshot().user, 'files'), false);
  await auth.changePassword(undefined, 'replacement-password');
  assert.equal(hasFeature(auth.getSnapshot().user, 'files'), true);
  assert.deepEqual(calls, ['/api/auth/login', '/api/auth/change-password', '/api/auth/me']);
  assert.equal(store.read(), 'session-only');
  assert(!JSON.stringify(auth.getSnapshot()).includes('password'));
});

test('an unreachable account check backs off and recovers without a reload', () => {
  assert.deepEqual([...AUTH_RETRY_DELAYS_MS], [2000, 4000, 8000, 15000, 30000]);
  assert.equal(retryDelay(-1), 2000);
  assert.equal(retryDelay(2), 8000);
  assert.equal(retryDelay(99), 30000);

  let status = 'unavailable';
  const listeners = new Set();
  const timers = [];
  let refreshes = 0;
  const retry = createAuthRetry({
    getStatus: () => status,
    refresh: () => { refreshes += 1; },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setTimer: (callback, ms) => { const handle = { callback, ms }; timers.push(handle); return handle; },
    clearTimer: (handle) => { const index = timers.indexOf(handle); if (index >= 0) timers.splice(index, 1); },
  });
  const notify = () => { for (const listener of [...listeners]) listener(); };
  // A timer that fires leaves the scheduler, so the bookkeeping mirrors the controller.
  const fire = () => {
    const handle = timers.at(-1);
    timers.splice(timers.indexOf(handle), 1);
    handle.callback();
  };
  try {
    assert.equal(timers.length, 1, 'an unavailable session retries immediately');
    assert.equal(timers[0].ms, 2000);

    // The refresh itself reports "checking" first; that must not stack another timer.
    status = 'checking'; notify();
    assert.equal(timers.length, 0);

    status = 'unavailable'; notify();
    assert.equal(timers.at(-1).ms, 4000, 'the next failure waits longer');
    fire();
    assert.equal(refreshes, 1);

    status = 'authenticated'; notify();
    status = 'unavailable'; notify();
    assert.equal(timers.at(-1).ms, 2000, 'a success resets the backoff');
  } finally {
    retry.dispose();
  }
  assert.equal(listeners.size, 0);
  assert.equal(timers.length, 0);

  const idle = createAuthRetry({
    getStatus: () => 'authenticated',
    refresh: () => {},
    subscribe: () => () => {},
    setTimer: () => { throw new Error('must not schedule'); },
    clearTimer: () => {},
  });
  idle.dispose();
});
