const CACHE = 'flarchat-shell-v1';
const SHELL = ['./', './index.html', './css/style.css', './css/features.css', './manifest.json', './icons/icon.svg',
  './js/app.js', './js/auth.js', './js/chatlist.js', './js/chat.js', './js/pinlock.js', './js/media.js',
  './js/core.js', './js/config.js', './js/features/settings.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Nur eigene GET-Anfragen; alles andere (Supabase, CDN) geht direkt ans Netz und wird nie gecacht.
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || caches.match('./index.html'))));
});
