// Service worker: the app shell works offline (stale-while-revalidate); API calls are never cached.
const CACHE = 'cycle-demo-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/lib/store.js',
  '/lib/api.js',
  '/lib/sync.js',
  '/lib/notify.js',
  '/lib/ui/dom.js',
  '/lib/ui/icons.js',
  '/lib/ui/kit.js',
  '/lib/ui/home.js',
  '/lib/ui/calendar.js',
  '/lib/ui/log.js',
  '/lib/ui/charts.js',
  '/lib/ui/history.js',
  '/lib/ui/settings.js',
  '/lib/ui/login.js',
  '/lib/domain/dates.js',
  '/lib/domain/units.js',
  '/lib/domain/cycles.js',
  '/lib/domain/forecast.js',
  '/lib/engine/rational.js',
  '/lib/engine/profiles.js',
  '/lib/engine/engine.js',
  '/lib/engine/window.js',
  '/lib/engine/index.js',
  '/vendor/sync-protocol/clock.js',
  '/vendor/sync-protocol/order.js',
  '/vendor/sync-protocol/canonical.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true, ignoreVary: true });
      const network = fetch(e.request)
        .then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; })
        .catch(() => undefined);
      if (cached) { void network; return cached; }
      return (await network) ?? (e.request.mode === 'navigate' ? cache.match('/index.html') : Response.error());
    }),
  );
});
