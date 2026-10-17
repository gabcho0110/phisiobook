// PhysioBook — Cloud Function за доставка на push известия (FCM Web Push).
// Задействя се при създаване на известие в RTDB и изпраща push към всички
// запазени FCM токени на получателя. Ползва runtime service account на функцията
// (НЕ счупения user SA ключ), затова FCM достъпът е наличен по подразбиране.
//
// Деплой (изисква Blaze план + вашия Firebase CLI логин):
//   cd functions && npm install
//   firebase deploy --only functions

const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const { onValueCreated } = require('firebase-functions/v2/database');
const logger = require('firebase-functions/logger');

initializeApp({
  databaseURL: 'https://physiobook-d6eff-default-rtdb.europe-west1.firebasedatabase.app'
});

exports.sendPushOnNotification = onValueCreated(
  {
    ref: '/clinics/{clinicId}/notifications/{notificationId}',
    region: 'europe-west1'
  },
  async (event) => {
    const notif = event.data.val();
    if (!notif || !notif.userId) return;

    const { clinicId, notificationId } = event.params;
    const userId = notif.userId;
    const title = notif.title || 'PhysioBook';
    const body = notif.text || '';

    const db = getDatabase();
    const snap = await db.ref(`clinics/${clinicId}/users/${userId}/fcmTokens`).once('value');
    const tokens = snap.val();
    if (!tokens) return;

    const tokenList = Object.keys(tokens)
      .map((k) => tokens[k] && tokens[k].token)
      .filter(Boolean);
    if (tokenList.length === 0) return;

    const messaging = getMessaging();
    const results = await Promise.allSettled(
      tokenList.map((token) =>
        messaging.send({
          token,
          notification: { title, body },
          data: {
            clinicId,
            notificationId,
            userId,
            type: notif.type || 'default',
            title: String(title),
            body: String(body),
            url: '/'
          },
          // Нативен Android (ако се ползва) — показва съдържанието на заключен екран.
          android: { notification: { visibility: 'public', color: '#1e4a78' } },
          // Web push (TWA/Chrome) — иконата и visibility за заключен екран.
          webpush: {
            notification: {
              icon: '/icon-512.png',
              badge: '/icon-192.png',
              visibility: 'public'
            }
          }
        })
      )
    );

    // Почистване на невалидни токени, за да не се пращат повторно.
    results.forEach((r, i) => {
      if (r.status !== 'rejected') return;
      const code = r.reason && r.reason.code;
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        const bad = tokenList[i];
        const key = Object.keys(tokens).find((k) => tokens[k] && tokens[k].token === bad);
        if (key) {
          db.ref(`clinics/${clinicId}/users/${userId}/fcmTokens/${key}`)
            .remove()
            .catch((e) => logger.warn('Неуспешно изтриване на токен:', e));
        }
      } else {
        logger.warn('FCM send грешка:', r.reason);
      }
    });
  }
);
