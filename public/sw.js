/* Matrius PWA service worker: precache the app shell, then serve it offline.
   Bump CACHE_NAME whenever the shell or the caching strategy changes. */
const CACHE_NAME = 'matrius-v4';
const APP_SHELL = [
  '/',
  '/manifest.json',
  '/favicon.ico',
  '/brand/matrius-color.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isCacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  // API traffic is account data and streaming responses; never cache it.
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname === '/sw.js') return false;
  // Metro bundles and hot-update files only exist on the dev server. The dev and production
  // servers share port 8081, so a worker left over from `npm run serve` would otherwise serve
  // an old development bundle after the code changed.
  if (url.searchParams.has('dev') || url.pathname.endsWith('.bundle') || url.pathname.startsWith('/node_modules/')
    || url.pathname.startsWith('/@') || url.pathname.startsWith('/__expo')) return false;
  return true;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheable(request)) return;

  // Navigations stay network-first so a new build is picked up immediately;
  // an offline load still gets the cached shell (SPA fallback).
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/').then((cached) => cached || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
