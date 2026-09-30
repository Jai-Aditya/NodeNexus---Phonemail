// Service worker: shows new-mail push notifications and opens the conversation when tapped.
// The api sends { title, body, conversation_id, message_id }, encrypted for this browser.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'New email', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'New email', {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.conversation_id ? `chat-${data.conversation_id}` : undefined, // one per chat, updated
    renotify: Boolean(data.conversation_id),
    data: { url: data.conversation_id ? `/c/${data.conversation_id}` : '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const tab of tabs) {
      if ('focus' in tab) {
        await tab.navigate(url).catch(() => {});
        return tab.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
