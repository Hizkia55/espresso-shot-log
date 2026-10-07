const CACHE_NAME = 'shot-log-v5';
const APP_SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'data.js',
  'lib/countries.js',
  'lib/idb-keyval.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

// GitHub Pages serves these with `cache-control: max-age=600`, so a plain
// fetch can hand us a ten-minute-old copy out of the HTTP cache. Bypass it
// for subresources. Navigation requests can't be rebuilt this way (the
// Request constructor rejects navigate mode), so those go through as-is.
function freshRequest(request) {
  if (request.mode === 'navigate') return request;
  return new Request(request, { cache: 'reload' });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })))
      )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        // Network-first. The shell is a handful of small files, so the round
        // trip costs almost nothing, and the launch after a deploy shows the
        // new UI instead of last launch's copy.
        const response = await fetch(freshRequest(event.request));
        if (response && response.ok) cache.put(event.request, response.clone());
        return response;
      } catch (err) {
        // Offline: serve the cached shell, falling back to index.html for
        // navigations so the app still opens.
        const cached = await cache.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const shell = await cache.match('index.html');
          if (shell) return shell;
        }
        throw err;
      }
    })()
  );
});
