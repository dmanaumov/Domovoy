// Минимальный service worker — только для установки PWA (кэш "app shell" добавим позже).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
