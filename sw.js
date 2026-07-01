const CACHE = 'gastos-v4';
const ASSETS = ['/login.html', '/app.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Network-first
self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith('http')) return;
  e.respondWith(
    fetch(e.request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return response;
      })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match('/login.html')))
  );
});

// ── Recibir notificación push ────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { data = { title: 'Mis Gastos', body: e.data.text() }; }

  e.waitUntil(
    self.registration.showNotification(data.title || 'Mis Gastos', {
      body: data.body || '',
      icon: data.icon || '/icon/icon-192.png',
      badge: '/icon/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'misgastos-notif',
      renotify: true,
      data: { url: '/app.html' }
    })
  );
});

// ── Click en notificación → abrir app ───────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
      const c = cs.find(c => c.url.includes('app.html'));
      if (c) return c.focus();
      return clients.openWindow('/app.html');
    })
  );
});
