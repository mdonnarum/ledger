/* Ledger service worker
   Purpose:
   1. Makes Ledger installable as a real app on desktop (Chrome/Edge require a
      service worker with a fetch handler) as well as on phones.
   2. Keeps the app working offline.
   3. Navigation is NETWORK-FIRST: when you're online you always get the latest
      version (no more "close and reopen to get the update"); when offline it
      falls back to the last cached copy. Static assets (icons, fonts) are
      cache-first for speed. Firebase / Firestore / auth traffic is never
      intercepted — it always goes straight to the network. */
const CACHE = 'ledger-app-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isFontHost = h => /fonts\.(googleapis|gstatic)\.com$/.test(h);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // Google Fonts: cache-first (they're immutable and safe to serve stale).
  if (isFontHost(url.host)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  // Only handle our own origin from here on — Firebase, Firestore, auth,
  // and any other cross-origin request passes straight through to the network.
  if (url.origin !== location.origin) return;

  const isNav = req.mode === 'navigate'
    || url.pathname.endsWith('/')
    || url.pathname.endsWith('index.html');

  if (isNav) {
    e.respondWith(networkFirstPage(req));
  } else {
    e.respondWith(cacheFirst(req));
  }
});

async function networkFirstPage(req) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const c = await caches.open(CACHE);
      c.put('./index.html', fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await caches.match('./index.html') || await caches.match(req);
    return cached || Response.error();
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const fresh = await fetch(req);
    if (fresh && (fresh.status === 200 || fresh.type === 'opaque')) {
      const c = await caches.open(CACHE);
      c.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    return cached || Response.error();
  }
}
