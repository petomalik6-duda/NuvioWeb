const CACHE = 'streamlet-web-v1';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/logo.svg', '/manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).pathname.startsWith('/api/')) return;
  event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(resp => {
    const copy = resp.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
    return resp;
  }).catch(() => caches.match('/index.html'))));
});
