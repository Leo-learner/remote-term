// Shows push notifications, and opens the session a notification is about when it is tapped.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Harbor', {
    body: data.body || '',
    tag: data.sessionId || data.kind || 'harbor',
    data: { sessionId: data.sessionId || null },
    icon: '/icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const target = sessionId ? `/app/#s=${encodeURIComponent(sessionId)}` : '/app/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).pathname.startsWith('/app')) {
        client.postMessage({ type: 'open-session', sessionId });
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
