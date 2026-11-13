// Service worker: makes the app installable, loads its look (CSS, icons)
// instantly from the phone, and shows a friendly offline screen when
// there's no signal. Signed-in pages are never stored on the device -
// they always come fresh from the server.
const VERSION = 'v1';
const CACHE = 'hvac-app-' + VERSION;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [
  OFFLINE_URL,
  '/css/styles.css',
  '/js/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-64.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('hvac-app-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Pages: always the network; the offline screen only when that fails.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // App look and feel: answer from the phone right away, refresh in the background.
  if (/^\/(css|js|icons)\//.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const fresh = fetch(req)
            .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
            .catch(() => hit);
          return hit || fresh;
        })
      )
    );
  }
});
