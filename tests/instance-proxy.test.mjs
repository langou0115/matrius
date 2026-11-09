import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import proxy from '../scripts/instance-model-proxy.cjs';

test('model relay requires the instance cookie and keeps provider credentials out of the auth check', async (t) => {
  const checks = [];
  let authorized = false;
  const api = createServer((req, res) => {
    checks.push({ path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization });
    res.writeHead(authorized ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(authorized ? { features: [] } : { error: { code: 'unauthorized' } }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const target = `http://127.0.0.1:${api.address().port}`;
  const web = createServer((req, res) => {
    if (!proxy.handleInstanceModelProxy(req, res, target)) { res.writeHead(404); res.end(); }
  });
  web.listen(0, '127.0.0.1'); await once(web, 'listening');
  t.after(() => { web.closeAllConnections(); api.closeAllConnections(); web.close(); api.close(); });
  const origin = `http://127.0.0.1:${web.address().port}`;
  const headers = { cookie: 'matrius_session=instance-token', authorization: 'Bearer provider-key' };
  const denied = await fetch(`${origin}/api/model-proxy/v1/models`, { headers });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, 'unauthorized');
  assert.deepEqual(checks[0], { path: '/api/features', cookie: headers.cookie, authorization: undefined });
  authorized = true;
  const allowed = await fetch(`${origin}/api/model-proxy/v1/models`, { headers });
  // Auth succeeded. The underlying relay now rejects the deliberately absent target header.
  assert.equal(allowed.status, 400);
  await allowed.arrayBuffer();
});
