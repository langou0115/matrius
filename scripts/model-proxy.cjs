'use strict';

/**
 * Same-origin relay for model providers that do not answer browser CORS preflights.
 *
 * Browsers cannot call such providers directly, but they can call this endpoint on their
 * own origin. The client puts the real provider origin in `x-matrius-target-origin` and
 * keeps every provider path segment in the request URL, so the relay only swaps origins:
 *
 *   POST /api/model-proxy/v1/messages
 *   x-matrius-target-origin: https://tokenhub.tencentmaas.com
 *     -> POST https://tokenhub.tencentmaas.com/v1/messages
 *
 * The relay is deliberately not an open proxy: by default it refuses credentials in the
 * target, loopback/private addresses and names, and (when configured) hosts outside
 * MATRIUS_PROXY_ALLOW_HOSTS. DNS answers are pinned for the actual request to close the
 * rebinding window between validation and connect.
 *
 * Used by both the Metro dev middleware (`metro.config.js`) and `server.mjs`.
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');

const PROXY_PREFIX = '/api/model-proxy';
const TARGET_HEADER = 'x-matrius-target-origin';
const ALLOWED_METHODS = new Set(['GET', 'POST']);
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function parseHostList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

const allowHosts = parseHostList(process.env.MATRIUS_PROXY_ALLOW_HOSTS);
const allowPrivate = process.env.MATRIUS_PROXY_ALLOW_PRIVATE === '1';

function isPrivateIp(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique local
    if (/^fe[89ab]/u.test(value)) return true; // link-local
    if (value.startsWith('64:ff9b:')) return true; // NAT64 can embed IPv4
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u);
    if (mapped) return isPrivateIp(mapped[1]);
    // URL parsing normalizes IPv4-mapped addresses to hex: ::ffff:7f00:1.
    const hexMapped = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
    if (hexMapped) {
      const high = Number.parseInt(hexMapped[1], 16);
      const low = Number.parseInt(hexMapped[2], 16);
      return isPrivateIp(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
    }
  }
  return false;
}

function isLocalName(hostname) {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal');
}

function readTarget(req) {
  const raw = req.headers[TARGET_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) return { status: 400, message: 'Missing proxy target.' };

  let target;
  try {
    target = new URL(value.trim());
  } catch {
    return { status: 400, message: 'Invalid proxy target.' };
  }
  if (!['http:', 'https:'].includes(target.protocol)) return { status: 400, message: 'Unsupported proxy target protocol.' };
  if (target.username || target.password) return { status: 400, message: 'Proxy target must not contain credentials.' };
  if (target.pathname !== '/' || target.search || target.hash) return { status: 400, message: 'Proxy target must be an origin.' };

  // URL#hostname keeps IPv6 brackets; DNS and net APIs want the bare address.
  const rawHostname = target.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname;
  if (allowHosts.length && !allowHosts.includes(hostname)) return { status: 403, message: 'Proxy target is not allowed.' };
  if (!allowPrivate && (isLocalName(hostname) || (net.isIP(hostname) && isPrivateIp(hostname)))) {
    return { status: 403, message: 'Proxy target is not allowed.' };
  }
  return {
    origin: target.origin,
    hostname,
    // URL#host keeps a non-default port, which must survive the rewrite.
    host: target.host.toLowerCase(),
    port: target.port ? Number(target.port) : (target.protocol === 'https:' ? 443 : 80),
    protocol: target.protocol,
  };
}

async function resolvePinnedAddress(hostname) {
  if (allowPrivate || net.isIP(hostname)) return undefined;
  const rows = await dns.promises.lookup(hostname, { all: true });
  if (!rows.length) throw new Error('DNS lookup failed');
  for (const row of rows) {
    if (isPrivateIp(row.address)) throw new Error('Resolved address is not public');
  }
  return rows[0];
}

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', typeof req.headers.origin === 'string' ? req.headers.origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', [
    'content-type',
    'authorization',
    'x-api-key',
    'anthropic-version',
    'anthropic-beta',
    'anthropic-dangerous-direct-browser-access',
    TARGET_HEADER,
  ].join(', '));
  res.setHeader('Vary', 'Origin');
}

function writeError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(message);
}

function getUpstreamPath(rawUrl) {
  const url = new URL(rawUrl || '/', 'http://proxy.invalid');
  let pathname = url.pathname;
  if (pathname === PROXY_PREFIX) pathname = '/';
  else if (pathname.startsWith(`${PROXY_PREFIX}/`)) pathname = pathname.slice(PROXY_PREFIX.length);
  return `${pathname}${url.search}`;
}

function forward(req, res, target, pinned) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === TARGET_HEADER || HOP_BY_HOP.has(lower)) continue;
    if (value !== undefined) headers[key] = value;
  }
  // Keep SSE unbuffered: let the browser see each upstream chunk immediately.
  headers['accept-encoding'] = 'identity';
  headers.host = target.host;

  const transport = target.protocol === 'https:' ? https : http;
  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: getUpstreamPath(req.url),
    headers,
  };
  if (target.protocol === 'https:' && !net.isIP(target.hostname)) requestOptions.servername = target.hostname;
  if (pinned) {
    // Node asks for `all` when autoSelectFamily is active; honor both callback shapes.
    requestOptions.lookup = (_hostname, options, callback) => {
      if (options?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
  }

  const upstream = transport.request(requestOptions, (upstreamResponse) => {
    res.statusCode = upstreamResponse.statusCode || 502;
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
      res.setHeader(key, value);
    }
    res.flushHeaders?.();
    upstreamResponse.pipe(res);
    upstreamResponse.on('error', () => res.destroy());
  });

  upstream.setTimeout(10 * 60 * 1000, () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => writeError(res, 502, 'Upstream request failed.'));
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });

  if (req.method === 'POST') req.pipe(upstream);
  else upstream.end();
}

/**
 * Returns true when this request belongs to the relay, so callers can skip their own
 * routing. The response may still be written asynchronously.
 */
function handleModelProxy(req, res) {
  const pathname = (req.url || '').split('?')[0];
  if (pathname !== PROXY_PREFIX && !pathname.startsWith(`${PROXY_PREFIX}/`)) return false;

  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return true;
  }
  if (!ALLOWED_METHODS.has(req.method || '')) {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    writeError(res, 405, 'Method Not Allowed');
    return true;
  }

  const target = readTarget(req);
  if (target.status) {
    writeError(res, target.status, target.message);
    return true;
  }

  resolvePinnedAddress(target.hostname)
    .then((pinned) => forward(req, res, target, pinned))
    .catch(() => writeError(res, 403, 'Proxy target is not allowed.'));
  return true;
}

module.exports = {
  handleModelProxy,
  PROXY_PREFIX,
  TARGET_HEADER,
};
