const http = require('node:http');
const net = require('node:net');

function resolveTarget(target) {
  if (!target) return null;
  let origin;
  try { origin = new URL(target); } catch { origin = {}; }
  if (origin.origin !== target || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') {
    return null;
  }
  return origin;
}

/** Same-origin API forwarding for Vite. Model relay is handled before this middleware. */
function handleDevApi(req, res, target = process.env.MATRIUS_DEV_API_URL) {
  if (!target || !req.url?.startsWith('/api/')) return false;
  const origin = resolveTarget(target);
  if (!origin) {
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

/** Forward `/api/` WebSocket upgrades (used by desktop work terminals) to the Node API. */
function handleDevUpgrade(req, socket, head, target = process.env.MATRIUS_DEV_API_URL) {
  if (!target || !req.url?.startsWith('/api/')) return false;
  const origin = resolveTarget(target);
  if (!origin) {
    socket.destroy();
    return true;
  }
  const port = Number(origin.port || 80);
  const upstream = net.connect({ host: origin.hostname, port }, () => {
    const headerLines = [`${req.method || 'GET'} ${req.url} HTTP/${req.httpVersion || '1.1'}`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index];
      const value = req.rawHeaders[index + 1];
      if (name.toLowerCase() === 'host') {
        headerLines.push(`Host: ${origin.host}`);
      } else {
        headerLines.push(`${name}: ${value}`);
      }
    }
    headerLines.push('', '');
    upstream.write(headerLines.join('\r\n'));
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  return true;
}

module.exports = { handleDevApi, handleDevUpgrade };
