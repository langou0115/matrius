import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker(overrides = {}) {
  const handlers = {};
  const context = vm.createContext({
    URL, Response,
    self: { location: { origin: 'https://matrius.test' }, addEventListener: (name, handler) => { handlers[name] = handler; } },
    ...overrides,
  });
  vm.runInContext(source, context);
  return { handlers, context };
}

test('worker excludes API, external and development traffic from caches', () => {
  const { context } = worker();
  for (const path of ['/api/auth/me', '/api/model-proxy/x', '/src/main.tsx', '/@vite/client', '/node_modules/x', '/assets/x.js?t=1', 'https://other.test/x']) {
    context.request = { method: 'GET', url: new URL(path, 'https://matrius.test').href };
    assert.equal(vm.runInContext('isCacheable(request)', context), false, path);
  }
});

test('offline navigation falls back to the cached shell', async () => {
  const shell = new Response('<html>offline shell</html>');
  const { handlers } = worker({ fetch: async () => { throw new Error('offline'); }, caches: { open: async () => ({ match: async (path) => path === '/' ? shell : undefined }) } });
  let response;
  handlers.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://matrius.test/settings/models' }, respondWith: (value) => { response = value; } });
  assert.equal(await (await response).text(), '<html>offline shell</html>');
});

test('failed precache rejects installation and preserves the previous worker', async () => {
  const { handlers } = worker({ caches: { open: async () => ({ addAll: async () => { throw new Error('missing asset'); } }) } });
  let installed;
  handlers.install({ waitUntil: (value) => { installed = value; } });
  await assert.rejects(installed, /missing asset/);
});
