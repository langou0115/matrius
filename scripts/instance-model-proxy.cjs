'use strict';

const modelProxy = require('./model-proxy.cjs');

/** Provider Authorization belongs to the upstream model. Only the instance cookie is
 * forwarded to the fixed backend when checking access to the relay. */
function handleInstanceModelProxy(req, res, apiOrigin = process.env.MATRIUS_API_URL || process.env.MATRIUS_DEV_API_URL) {
  if (!req.url?.startsWith('/api/model-proxy/')) return false;
  const check = async () => {
    try {
      if (!apiOrigin) throw new Error('Missing instance API');
      const response = await fetch(new URL('/api/features', apiOrigin), {
        headers: { cookie: req.headers.cookie || '' },
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(await response.text());
        return;
      }
      await response.body?.cancel();
      if (!res.destroyed) modelProxy.handleModelProxy(req, res);
    } catch {
      if (res.destroyed) return;
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end('{"error":{"code":"unavailable","message":"Instance API unavailable."}}');
    }
  };
  void check();
  return true;
}

module.exports = { handleInstanceModelProxy };
