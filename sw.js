/* Offline cache for Pay Clock.

   The page itself is fetched NETWORK-FIRST: every launch tries the live site and falls
   back to the cached copy only when offline. Updates therefore arrive on the first
   open — no version churn, no two-open lag, and far less service-worker update
   activity, which iOS home-screen apps handle badly (rapid updates can crash-loop
   with "a problem repeatedly occurred").

   Static assets (icons, manifest) stay cache-first; they effectively never change. */
const CACHE = 'wisewage-v77';
const ASSETS = ['./', './index.html', './manifest.webmanifest',
                './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const isPage = e.request.mode === 'navigate' ||
                 e.request.destination === 'document' ||
                 /(\/|index\.html)$/.test(new URL(e.request.url).pathname);

  if (isPage) {
    /* Network first, and explicitly past the browser's own HTTP cache.

       GitHub Pages serves HTML with max-age=600. Chromium turns out to revalidate here
       anyway — a test that serves the page with that header and changes it mid-flight
       passes with or without the no-store below — so this is a precaution, not a fix for
       any bug reproduced in this repo. It is kept because WebKit cannot be tested in this
       sandbox and is the stricter HTTP cache of the two, and because "always ask the
       origin" is what this branch is meant to mean. If it ever needs removing, the
       plain fetch(e.request) form behaves identically under test. */
    e.respondWith(
      fetch(e.request.url, { cache: 'no-store' })
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            // Stored under the canonical key so the offline fallback below always finds
            // the newest copy, whichever URL form the launch used.
            caches.open(CACHE).then(c => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then(hit => hit || caches.match(e.request)))
    );
    return;
  }

  // Assets: cache first, refresh quietly in the background.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const live = fetch(e.request)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || live;
    })
  );
});
