#!/usr/bin/env node
/**
 * ============================================================================
 * PhysioBook — еднократна миграция към Firebase Authentication
 * ============================================================================
 *
 * Създава Firebase Auth акаунт за всеки съществуващ потребител, пациент и
 * администратор, БЕЗ да променя 6-цифрения му код. Кодът остава същият —
 * той просто става и парола на акаунта:
 *
 *     email    = "<код>@physiobook.eu"      напр. 123456@physiobook.eu
 *     password = "<код>"                     напр. 123456
 *
 * УПОТРЕБА:
 *   node scripts/migrate-auth.mjs                          # dry-run
 *   node scripts/migrate-auth.mjs --apply                  # през публичния API
 *   node scripts/migrate-auth.mjs --apply --key <ключ>.json # през Admin API
 *
 * С service account ключ (--key) скриптът използва Admin API на Identity
 * Toolkit и може да маркира имейлите като потвърдени. Без ключ използва
 * публичния `accounts:signUp` endpoint и Web API ключа на проекта.
 *
 * ПРЕДИ ДА ПУСНЕТЕ СКРИПТА:
 *   1. Firebase Console → Authentication → Sign-in method → Email/Password
 *   2. Базата трябва да е четима (скриптът чете `accessCode` от нея).
 *      Затова се пуска ПРЕДИ заключването на правилата.
 *
 * ПОВЕРИТЕЛНОСТ:
 *   Скриптът тегли записите в паметта, извлича само кодовете и НИЩО не
 *   записва на диск. Медицинските данни не се запазват.
 * ============================================================================
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

const PROJECT_ID = 'physiobook-d6eff';
const DB_URL = `https://${PROJECT_ID}-default-rtdb.europe-west1.firebasedatabase.app`;
const WEB_API_KEY = 'AIzaSyCQl5_htAdWIzabLqdNi1c5v7tQ1NqUDFY';
const EMAIL_DOMAIN = 'physiobook.eu';

const APPLY = process.argv.includes('--apply');
const keyIdx = process.argv.indexOf('--key');
const KEY_PATH = keyIdx >= 0 ? process.argv[keyIdx + 1] : process.env.GOOGLE_APPLICATION_CREDENTIALS;

// ───────────────────────────── Auth ─────────────────────────────────────────

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const sa = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const jwt = `${signingInput}.${signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Неуспешен достъп до Google: ${JSON.stringify(body)}`);
  return body.access_token;
}

// ──────────────────────────── Създаване ─────────────────────────────────────

async function createAccountAdmin(code, token) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT_ID}/accounts`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${code}@${EMAIL_DOMAIN}`,
        password: code,
        emailVerified: true
      })
    }
  );
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, uid: body.localId };
  const msg = body?.error?.message || `HTTP ${res.status}`;
  if (msg === 'EMAIL_EXISTS') return { ok: true, skipped: true };
  return { ok: false, reason: msg };
}

async function createAccountPublic(code) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `${code}@${EMAIL_DOMAIN}`, password: code, returnSecureToken: false })
    }
  );
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, uid: body.localId };
  const msg = body?.error?.message || `HTTP ${res.status}`;
  if (msg === 'EMAIL_EXISTS') return { ok: true, skipped: true };
  return { ok: false, reason: msg };
}

// ──────────────────────────────── Данни ─────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

function collectCodes(clinics, admins) {
  const byCode = new Map();
  const add = (code, entry) => {
    if (!code || !/^\d{6}$/.test(String(code))) return;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(entry);
  };

  for (const [clinicId, clinic] of Object.entries(clinics || {})) {
    for (const [id, u] of Object.entries(clinic?.users || {})) {
      add(u?.accessCode, { clinicId, type: 'потребител', name: u?.name || '—', id });
    }
    for (const [id, p] of Object.entries(clinic?.patients || {})) {
      add(p?.accessCode, { clinicId, type: 'пациент', name: p?.name || '—', id });
    }
  }
  for (const [id, a] of Object.entries(admins || {})) {
    add(a?.accessCode, { clinicId: '—', type: 'администратор', name: a?.name || '—', id });
  }
  return byCode;
}

// ──────────────────────────────── main ──────────────────────────────────────

async function main() {
  console.log('PhysioBook → Firebase Auth миграция');
  console.log(`Метод: ${KEY_PATH ? 'Admin API (service account)' : 'публичен API'}`);
  console.log(`Режим: ${APPLY ? '⚠️  ПРИЛАГАНЕ' : 'dry-run (нищо не се променя)'}`);
  console.log('');

  console.log('1/3 Четене на структурата на базата…');
  const clinics = await getJson(`${DB_URL}/clinics.json`);
  const admins = await getJson(`${DB_URL}/admins.json`);
  const byCode = collectCodes(clinics, admins);
  console.log(`    Намерени кодове: ${byCode.size}`);

  const shared = [...byCode.entries()].filter(([, list]) => list.length > 1);
  if (shared.length) {
    console.log('');
    console.log(`ℹ️  ${shared.length} кода се срещат в повече от един запис (един акаунт на код):`);
    for (const [code, list] of shared) {
      console.log(`    ${code} → ${list.map((e) => `${e.type} „${e.name}"`).join(' + ')}`);
    }
  }

  const codes = [...byCode.keys()];
  console.log('');
  console.log(`2/3 Акаунти за създаване: ${codes.length}`);

  if (!APPLY) {
    codes.slice(0, 10).forEach((c) => console.log(`      ${c}@${EMAIL_DOMAIN}`));
    console.log('');
    console.log('Готово. Пуснете с --apply, за да създадете акаунтите.');
    return;
  }

  console.log('3/3 Създаване…');
  const token = KEY_PATH ? await getAccessToken() : null;
  let created = 0, skipped = 0;
  const failed = [];

  for (const code of codes) {
    const result = token
      ? await createAccountAdmin(code, token)
      : await createAccountPublic(code);
    if (result.ok && result.skipped) { skipped++; continue; }
    if (result.ok) { created++; continue; }
    failed.push({ code, reason: result.reason });
  }

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`Създадени:        ${created}`);
  console.log(`Вече съществуват: ${skipped}`);
  console.log(`Неуспешни:        ${failed.length}`);
  failed.forEach((f) => console.log(`   ${f.code} — ${f.reason}`));
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log('СЛЕДВАЩА СТЪПКА: качете новите index.html и admin.html, проверете');
  console.log('входа и едва тогава deploy-нете правилата.');
}

main().catch((err) => {
  console.error('');
  console.error('❌ Грешка:', err.message);
  process.exit(1);
});
