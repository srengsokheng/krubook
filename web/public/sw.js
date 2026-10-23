// KruBook service worker.
// - App shell and hashed assets: cache-first, so the app opens without a connection.
// - GET /api/*: network-first; the last good response is served when offline, marked with
//   `x-krubook-offline: 1` so the page can say it is showing saved data.
// - Writes are never cached here; the page queues them in IndexedDB (see src/offline.ts).
const SHELL = 'krubook-shell-v1';
const API = 'krubook-api-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'precache' && Array.isArray(msg.urls)) {
    event.waitUntil(caches.open(SHELL).then((c) => Promise.all(msg.urls.map((u) => c.add(u).catch(() => null)))));
  }
  if (msg.type === 'clear-api') event.waitUntil(caches.delete(API));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (/^\/api\/(export|backup|auth)/.test(url.pathname)) return;
    event.respondWith(networkFirstApi(req));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then((res) => { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/index.html', copy)); return res; }).catch(() => caches.match('/index.html')));
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && (url.pathname.startsWith('/assets/') || SHELL_URLS.includes(url.pathname))) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});

async function networkFirstApi(req) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (!hit) {
      return new Response(JSON.stringify({ error: 'You are offline, and this page has not been opened on this device before.' }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    const headers = new Headers(hit.headers);
    headers.set('x-krubook-offline', '1');
    return new Response(await hit.blob(), { status: 200, headers });
  }
}
