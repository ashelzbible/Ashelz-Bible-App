// Wazzupp service worker: web push, notification routing, and an offline app shell.
const SHELL = 'wz-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/icons/logo-192.png', '/manifest.webmanifest'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/ws')) return; // never cache API or signed media
  e.respondWith(fetch(e.request).then((r) => { if (r.ok && (u.pathname.startsWith('/assets/') || u.pathname === '/')) { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match('/'))));
});
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Wazzupp', body: 'New message' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Wazzupp', { body: d.body || '', tag: d.tag, icon: '/icons/logo-192.png', badge: '/icons/logo-96.png', data: d.data || {}, renotify: true }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.conversationId;
  const url = id ? `/#/chats/${id}` : '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => { for (const c of cs) { if ('focus' in c) { c.navigate(url); return c.focus(); } } return self.clients.openWindow(url); }));
});
