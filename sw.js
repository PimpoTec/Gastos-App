const CACHE = 'gastos-v3';
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

// Network-first: siempre intenta traer la versión más nueva del servidor.
// Solo usa el caché si no hay conexión a internet.
self.addEventListener('fetch', e => {
  // Ignorar requests que no sean http/https (ej: chrome-extension://)
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
