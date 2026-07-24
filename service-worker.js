const CACHE_NAME = 'shot-log-v3';
const APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'lib/idb-keyval.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      // Stale-while-revalidate: serve the cached copy instantly (if any) but
      // always refetch in the background so the *next* load has the latest
      // app.js/styles.css without needing a manual CACHE_NAME bump.
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.ok) cache.put(event.request, response.clone());
          return response;
        })
        .catch(() => cached);
      event.waitUntil(network);
      return cached || network;
    })
  );
});
