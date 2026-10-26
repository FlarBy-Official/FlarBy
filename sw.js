const CACHE = 'flarchat-shell-v43';
const SHELL = ['./', './index.html', './css/style.css', './css/features.css', './css/ios.css', './icons/icon-180.png', './manifest.json', './icons/icon.svg', './icons/verified.png', './agb.html',
  './js/app.js', './js/auth.js', './js/chatlist.js', './js/chat.js', './js/features/mentions.js', './js/features/reminders.js', './js/features/voice.js', './js/features/push.js', './js/pinlock.js', './js/media.js', './js/avatar.js',
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

// ---- Push-Mitteilungen ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const tag = d.tag || d.chat_id || 'flarchat';
  e.waitUntil((async () => {
    let body = d.body || 'Neue Nachricht';
    let count = 1;
    if (d.kind === 'message') {
      const old = await self.registration.getNotifications({ tag });
      count = ((old[0] && old[0].data && old[0].data.count) || old.length) + 1;
      if (!old.length) count = 1;
      if (count > 1) body = count + ' neue Nachrichten';
    }
    await self.registration.showNotification(d.title || 'FlarChat', {
      body, tag, renotify: true, icon: './icons/icon-180.png', badge: './icons/icon-180.png',
      data: { chat_id: d.chat_id || null, count },
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const chatId = e.notification.data && e.notification.data.chat_id;
  const target = new URL(chatId ? './#/chat/' + chatId : './', self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find(c => c.url.startsWith(self.registration.scope));
    if (open) {
      try { await open.focus(); } catch { /* ignorieren */ }
      if ('navigate' in open) { try { await open.navigate(target); } catch { /* ignorieren */ } }
      return;
    }
    await self.clients.openWindow(target);
  })());
});
