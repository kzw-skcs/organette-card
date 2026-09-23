const CACHE_NAME = 'organette-card-v8';
const CACHE_FILES = [
  './', './index.html', './manifest.json',
  './icon-192.png', './icon-512.png', './icon-180.png', './omr.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(CACHE_FILES).catch(err => console.warn('Cache partial fail:', err))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (event.request.url.includes('index.html') || event.request.url.endsWith('/') || event.request.url.endsWith('omr.js')) {
        return fetch(event.request)
          .then(res => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, copy));
            return res;
          }).catch(() => cached);
      }
      return cached || fetch(event.request);
    })
  );
});
