/* ==========================================================================
   PhysioBook — Service Worker
   ==========================================================================

   ВКЛЮЧЕН. Регистрира се от index.html (`navigator.serviceWorker.register('/sw.js')`).

   Стратегия:
     • Навигация / HTML  → network-first (винаги най-новата версия; кешът е само
                           резерва, когато няма мрежа). Така поправен бъг НЕ може
                           да „се върне" от залежал кеш.
     • Статични ресурси  → stale-while-revalidate (бързо + самообновяващо се)
     • Всичко извън нашия домейн (Firebase, gstatic, cdnjs) → не се пипа

   При всяко ново издание ВДИГНЕТЕ версията в CACHE по-долу — тогава при
   активиране старите кешове се изтриват.
   ========================================================================== */

const CACHE = 'physiobook-v4';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './i18n.js',
  './i18n-data.js',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Кешираме всеки ресурс поотделно: един липсващ файл не бива да
      // проваля цялата инсталация на service worker-а.
      await Promise.all(
        APP_SHELL.map((url) => cache.add(url).catch(() => {}))
      );
      await self.skipWaiting();
    })()
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

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
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
