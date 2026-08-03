// The installer service worker, served from inside its own scope.
//
// Served by a route handler rather than a file in /public because /public is
// shared and this worker must only ever control /admin/install. A worker's
// scope is capped by the path it is served from, so `/admin/install/sw.js`
// cannot claim the customer portal even by accident.
//
// STRATEGY
//   navigation   network first, cache fallback. Fresh when there is signal,
//                and the last good shell when there is none.
//   static       cache first. Next's /_next/static assets are content-hashed,
//                so a cached one is never stale.
//   everything   else passes straight through. Captures are NOT cached here —
//                the IndexedDB queue owns that, and a service worker replaying
//                a POST it half-understood is how duplicate devices happen.
const SOURCE = `
const CACHE = 'overwatch-install-v1';
const SHELL = '/admin/install';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll([SHELL])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL).then((cached) => cached || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
  }
});
`;

export function GET(): Response {
  return new Response(SOURCE, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/admin/install/',
    },
  });
}
