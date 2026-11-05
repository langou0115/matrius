'use strict';

/**
 * The development server answers an unknown path with the SPA's index.html and a 200, which
 * is why a missing icon is silent: the `<img>` receives HTML, fails to decode it and renders
 * nothing, with no console error. Guard the asset folders we serve from `public/` so a missing
 * file is a visible 404 instead of a fake page.
 *
 * Only directories owned by `public/` are guarded. Metro's bundle and asset URLs live under
 * other roots and must keep flowing to the dev server.
 */

const fs = require('node:fs');
const path = require('node:path');

const GUARDED_DIRECTORIES = new Set(['brand', 'vendor', 'icons']);
const GUARDED_FILES = new Set(['manifest.json', 'sw.js']);

function decodePathname(rawUrl) {
  try { return decodeURIComponent(new URL(rawUrl || '/', 'http://localhost').pathname); }
  catch { return null; }
}

/** Resolved file, `null` for a guarded but unsafe path, `undefined` when not guarded. */
function guardedFile(publicDir, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return undefined;
  if (!GUARDED_DIRECTORIES.has(segments[0]) && !GUARDED_FILES.has(segments[0])) return undefined;
  if (segments.some((segment) => segment === '..' || segment === '.')) return null;
  const root = path.resolve(publicDir);
  const candidate = path.resolve(root, ...segments);
  if (!candidate.startsWith(`${root}${path.sep}`)) return null;
  return candidate;
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); }
  catch { return false; }
}

/**
 * Returns true when this request was handled. A guarded asset that is missing from `public/`
 * is answered with 404; everything else is left to the normal dev-server middleware.
 */
function handleStaticMiss(req, res, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = decodePathname(req.url);
  if (!pathname) return false;
  const file = guardedFile(publicDir, pathname);
  if (file === undefined) return false;
  if (file !== null && isFile(file)) return false;

  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD') { res.end(); return true; }
  res.end(file === null ? 'Invalid asset path.\n' : `Missing public asset: ${pathname}\n`);
  return true;
}

module.exports = { handleStaticMiss, GUARDED_DIRECTORIES, GUARDED_FILES };
