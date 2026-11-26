/* HomeVault PWA – Offline-First Service Worker (Zero CDN, Relative Subpath Ready) */
const CACHE_NAME = 'homevault-pwa-v4.1.0';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './assets/favicon.svg',
  './assets/favicon.ico',
  './assets/icon.svg',
  './assets/apple-touch-icon.png',
  './assets/icon-512.png',
  './assets/providers_contacts.json',
  './js/db/schema.js',
  './js/storage/storage-manager.js',
  './js/storage/backup-service.js',
  './js/services/emergency-contacts.js',
  './js/services/pdf-service.js',
  './js/services/csv-importer.js',
  './js/app.js',
  './vendor/tailwind/tailwindcss.js',
  './vendor/alpine/alpine.min.js',
  './vendor/sqljs/sql-wasm.js',
  './vendor/sqljs/sql-wasm.wasm',
  './vendor/jszip/jszip.min.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/papaparse/papaparse.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Nur Anfragen innerhalb des eigenen Scopes abfangen (wichtig für GitHub-Pages-Unterpfade wie /homevault-pwa/)
  if (self.registration && self.registration.scope && !url.href.startsWith(self.registration.scope)) {
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return response;
        })
        .catch(() => {
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline – Datei nicht im Cache.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        });
    })
  );
});
