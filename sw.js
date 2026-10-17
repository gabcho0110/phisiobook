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

// ── FCM Web Push: background съобщения → известие на заключен екран ─────────
// Заредено през compat build-овете на gstatic. Ако gstatic е недостъпен при
// инсталация, push-ът просто отпада, но кеширащата логика по-долу остава.
let _fcm = null;
try {
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyCQl5_htAdWIzabLqdNi1c5v7tQ1NqUDFY",
    authDomain: "physiobook-d6eff.firebaseapp.com",
    databaseURL: "https://physiobook-d6eff-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "physiobook-d6eff",
    storageBucket: "physiobook-d6eff.firebasestorage.app",
    messagingSenderId: "72682142520",
    appId: "1:72682142520:web:ef39ae0e5ca3d48f5cdfcd"
  });
  _fcm = firebase.messaging();
  _fcm.onBackgroundMessage((payload) => {
    const n = (payload && payload.notification) || {};
    const data = (payload && payload.data) || {};
    const title = n.title || data.title || 'PhysioBook';
    const body = n.body || data.body || '';
    const options = {
      body: body,
      icon: '/icon-512.png',
      badge: '/icon-192.png',
      tag: data.tag || 'physiobook',
      data: data,
      visibility: 'public'
    };
    return self.registration.showNotification(title, options);
  });
} catch (e) { console.warn('FCM push disabled:', e); }

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          try { c.postMessage({ type: 'notificationClick', data: event.notification.data }); } catch (_) {}
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

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
