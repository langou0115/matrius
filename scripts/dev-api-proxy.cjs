const http = require('node:http');

/** Same-origin API forwarding for Vite. Model relay is handled before this middleware. */
function handleDevApi(req, res, target = process.env.MATRIUS_DEV_API_URL) {
  if (!target || !req.url?.startsWith('/api/')) return false;
  let origin;
  try { origin = new URL(target); } catch { origin = {}; }
  if (origin.origin !== target || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') {
    res.statusCode = 502;
    res.end('Invalid development API address.');
    return true;
  }
  // Keep the original path verbatim; do not interpret // as a different origin.
  const upstream = http.request({ hostname: origin.hostname, port: origin.port, path: req.url,
    method: req.method, headers: { ...req.headers, host: origin.host } }, (response) => {
    response.on('error', () => res.destroy());
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"unavailable","message":"本机 API 暂不可用。"}}'); }
    else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
  return true;
}

module.exports = { handleDevApi };
