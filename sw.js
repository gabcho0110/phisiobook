/* ==========================================================================
   PhysioBook — Service Worker
   ==========================================================================

   ВАЖНО: Този service worker е умишлено ИЗКЛЮЧЕН.

   В края на index.html има блок, който дерегистрира всички service workers
   при зареждане на страницата. Причината е, че приложение, което се обновява
   често, не бива да сервира залежала стара версия от кеша.

   За да ВКЛЮЧИТЕ офлайн кеширането:
     1. Премахнете <script> блока с navigator.serviceWorker.getRegistrations()
        в края на index.html.
     2. Регистрирайте този файл, например:
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js');
          }
     3. При всяко ново издание на приложението вдигнете версията в CACHE по-долу
        (напр. 'physiobook-v3'), за да се изчисти старият кеш.

   Стратегия:
     • Навигация / HTML  → network-first (винаги най-новата версия, кеш само
                           като резерва при липса на мрежа)
     • Статични ресурси  → stale-while-revalidate (бързо + самообновяващо се)
     • Всичко извън нашия домейн (Firebase, CDN) → не се пипа
   ========================================================================== */

const CACHE = 'physiobook-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Само GET заявки
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Заявки извън нашия домейн (Firebase, gstatic, cdnjs) не се кешират
  if (url.origin !== self.location.origin) return;

  // ── Навигация / HTML → network-first ────────────────────────────────
  const accept = request.headers.get('accept') || '';
  if (request.mode === 'navigate' || accept.includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  // ── Статични ресурси → stale-while-revalidate ──────────────────────
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
