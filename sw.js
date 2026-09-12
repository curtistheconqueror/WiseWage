/* Offline cache for WiseWage.

   The page itself is fetched NETWORK-FIRST: every launch tries the live site and falls
   back to the cached copy only when offline. Updates therefore arrive on the first
   open — no version churn, no two-open lag, and far less service-worker update
   activity, which iOS home-screen apps handle badly (rapid updates can crash-loop
   with "a problem repeatedly occurred").

   Static assets (icons, manifest) stay cache-first; they effectively never change. */
const CACHE = 'wisewage-v80';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './apple-touch-icon.png',
                './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

/* True only for the app page itself. `mode === 'navigate'` is not enough on its own:
   fresh.html is also a navigation, and caching its response under the './index.html' key
   would leave the offline fallback serving the escape hatch — a launch with no network
   would unregister the worker and wipe the cache instead of opening the app. */
const isAppPage = url => /(^|\/)(index\.html)?$/.test(new URL(url).pathname);

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
    /* Network first, past the browser's own HTTP cache.

       This used to pass { cache: 'no-store' }, with a comment saying WebKit could not be
       tested in this sandbox. It could not, and it was the thing that broke: an iPhone sat
       on a build for over a day across seven cold starts while the server had the new one.
       If that option is unsupported or the fetch rejects for any reason, this branch falls
       through to the cached copy — and because the cache is only rewritten on a successful
       fetch, a device that lands there once stays on that page forever. A stale-forever app
       is a worse failure than a stale-for-ten-minutes one.

       A unique query string does the same job using nothing but a URL, which every engine
       supports. GitHub Pages ignores the parameter and serves the same file. */
    const bust = e.request.url + (e.request.url.indexOf('?') > -1 ? '&' : '?')
               + '_sw=' + Date.now();
    e.respondWith(
      fetch(bust, { credentials: 'same-origin' })
        .then(res => {
          if (res && res.ok && isAppPage(e.request.url)) {
            const copy = res.clone();
            // Stored under the canonical key so the offline fallback below always finds
            // the newest copy, whichever URL form the launch used.
            caches.open(CACHE).then(c => c.put('./index.html', copy));
          }
          return res;
        })
        .catch(() => (isAppPage(e.request.url)
          ? caches.match('./index.html').then(hit => hit || caches.match(e.request))
          : caches.match(e.request)))
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
