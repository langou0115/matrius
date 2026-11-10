const http = require('node:http');

/**
 * Same-origin forwarding for the agent service during development. Agent runs are
 * server-sent events, so responses are streamed as-is and never buffered or timed out.
 * Production routing is a deployment concern and is not wired here.
 */
function handleDevAgent(req, res, target = process.env.MATRIUS_DEV_AGENT_URL || 'http://127.0.0.1:8123') {
  if (!req.url) return false;
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/agent') && !path.startsWith('/api/copilotkit')) return false;
  let origin;
  try { origin = new URL(target); } catch { origin = {}; }
  if (origin.origin !== target || origin.protocol !== 'http:'
    || (origin.hostname !== '127.0.0.1' && origin.hostname !== 'localhost')) {
    res.statusCode = 502;
    res.end('Invalid development agent address.');
    return true;
  }
  const upstream = http.request({
    hostname: origin.hostname,
    port: origin.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: origin.host },
  }, (response) => {
    response.on('error', () => res.destroy());
    const headers = { ...response.headers };
    // Streams are chunked: a forwarded length would be truncated by the proxy.
    delete headers['content-length'];
    res.writeHead(response.statusCode, headers);
    res.flushHeaders?.();
    response.pipe(res);
  });
  upstream.setTimeout(0);
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"error":{"code":"unavailable","message":"Agent 服务暂不可用，请运行 npm run agent。"}}');
    } else res.destroy();
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
  return true;
}

module.exports = { handleDevAgent };
