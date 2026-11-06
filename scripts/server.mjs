import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import modelProxy from './model-proxy.cjs';

/**
 * Production web server: serves the built `dist/` and the same-origin model relay.
 * Run `npm run build` first, then `node scripts/server.mjs`.
 *
 * Environment:
 *   PORT | HOST                      listen address (default 8081 / 0.0.0.0)
 *   MATRIUS_STATIC_DIR               static root (default ./dist)
 */

const { handleModelProxy } = modelProxy;

const root = resolve(process.env.MATRIUS_STATIC_DIR || fileURLToPath(new URL('../dist', import.meta.url)));
const port = Number(process.env.PORT || 8081);
const host = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function resolveWithinRoot(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

/** Mirrors the Nginx config: exact file, route `.html`, directory index, then SPA fallback. */
function findStaticFile(pathname) {
  const base = resolveWithinRoot(pathname);
  if (!base) return null;
  for (const candidate of [base, `${base}.html`, join(base, 'index.html')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function isAssetPath(pathname) {
  return pathname.startsWith('/assets/')
    || pathname.startsWith('/vendor/')
    || pathname.includes('.');
}

const server = http.createServer((req, res) => {
  if (handleModelProxy(req, res)) return;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Allow', 'GET, HEAD');
    res.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  const file = findStaticFile(pathname) || (isAssetPath(pathname) ? null : join(root, 'index.html'));
  if (!file) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }

  res.setHeader('Content-Type', MIME_TYPES[extname(file).toLowerCase()] || 'application/octet-stream');
  if (file.includes(`${sep}assets${sep}`)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  // The service worker, manifest and SPA shell must be revalidated so a new
  // build is picked up instead of being served from a stale cache.
  if (pathname === '/sw.js' || pathname === '/manifest.json' || file === join(root, 'index.html')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).on('error', () => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }).pipe(res);
});

server.listen(port, host, () => {
  console.log(`Matrius web on http://${host}:${port} (static root: ${root})`);
});
