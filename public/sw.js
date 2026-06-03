'use strict';

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));

// ── Handle incoming push notifications ────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let data;
  try { data = event.data.json(); }
  catch (_) { data = { title: '⚡ Lightning Alert', body: event.data.text(), danger: false }; }

  const options = {
    body:      data.body,
    icon:      './icon.svg',
    badge:     './icon.svg',
    tag:       'lightning',
    renotify:  true,
    vibrate:   data.danger ? [200, 100, 200, 100, 400] : [200, 100, 200],
    data:      { url: self.registration.scope }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── Tap notification to open app ──────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(self.registration.scope);
    })
  );
});
