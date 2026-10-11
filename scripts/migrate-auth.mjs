#!/usr/bin/env node
/**
 * ============================================================================
 * PhysioBook — еднократна миграция към Firebase Authentication
 * ============================================================================
 *
 * Създава Firebase Auth акаунт за всеки съществуващ потребител и пациент,
 * БЕЗ да променя 6-цифрения му код. Кодът остава същият — той просто става
 * и парола на акаунта:
 *
 *     email    = "<код>@physiobook.eu"      напр. 123456@physiobook.eu
 *     password = "<код>"                     напр. 123456
 *
 * ПРЕДИ ДА ПУСНЕТЕ СКРИПТА:
 *   1. Firebase Console → Authentication → Sign-in method →
 *      включете "Email/Password" и запишете.
 *   2. Базата все още трябва да е публично четима — скриптът чете
 *      `accessCode` от нея. Затова се пуска ПРЕДИ заключването на правилата.
 *
 * УПОТРЕБА:
 *   node scripts/migrate-auth.mjs             # dry-run: само показва плана
 *   node scripts/migrate-auth.mjs --apply     # създава акаунтите
 *
 * ЗАБЕЛЕЖКА ЗА ПОВЕРИТЕЛНОСТ:
 *   Скриптът тегли записите от базата в паметта, извлича само кодовете и
 *   НИЩО не записва на диск. Медицинските данни не се запазват.
 * ============================================================================
 */

const PROJECT_ID = 'physiobook-d6eff';
const DB_URL = `https://${PROJECT_ID}-default-rtdb.europe-west1.firebasedatabase.app`;
const API_KEY = 'AIzaSyCQl5_htAdWIzabLqdNi1c5v7tQ1NqUDFY';
const EMAIL_DOMAIN = 'physiobook.eu';

const APPLY = process.argv.includes('--apply');

// ─────────────────────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res.json();
}

async function createAccount(code) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${code}@${EMAIL_DOMAIN}`,
        password: code,
        returnSecureToken: false
      })
    }
  );
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, uid: body.localId };
  const reason = body?.error?.message || `HTTP ${res.status}`;
  if (reason === 'EMAIL_EXISTS') return { ok: true, skipped: true };
  return { ok: false, reason };
}

// ─────────────────────────────────────────────────────────────────────────────

function collectCodes(clinics, admins) {
  /** @type {Map<string, {clinicId: string, type: string, name: string, id: string}[]>} */
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

async function main() {
  console.log('PhysioBook → Firebase Auth миграция');
  console.log(`Режим: ${APPLY ? '⚠️  ПРИЛАГАНЕ (създават се акаунти)' : 'dry-run (нищо не се променя)'}`);
  console.log('');

  console.log('1/3 Четене на структурата на базата…');
  const clinics = await getJson(`${DB_URL}/clinics.json`);
  const admins = await getJson(`${DB_URL}/admins.json`);
  const byCode = collectCodes(clinics, admins);
  console.log(`    Намерени кодове: ${byCode.size}`);

  // Един и същ код може да се среща в няколко записа — например собственик на
  // клиника, който съществува едновременно като администратор и като потребител
  // на клиниката, или човек, член на две клиники. Това е нормално: създава се
  // ЕДИН Auth акаунт за всеки отделен код.
  const shared = [...byCode.entries()].filter(([, list]) => list.length > 1);
  if (shared.length) {
    console.log('');
    console.log(`ℹ️  ${shared.length} кода се срещат в повече от един запис (един акаунт на код):`);
    for (const [code, list] of shared) {
      console.log(`    ${code} → ${list.map((e) => `${e.type} „${e.name}"`).join(' + ')}`);
    }
  }

  const uniqueCodes = [...byCode.keys()];

  console.log('');
  console.log(`2/3 Акаунти за създаване: ${uniqueCodes.length}`);
  if (!APPLY) {
    console.log('    (dry-run — списък с първите 10)');
    uniqueCodes.slice(0, 10).forEach((c) => console.log(`      ${c}@${EMAIL_DOMAIN}`));
    console.log('');
    console.log('Готово. Пуснете с --apply, за да създадете акаунтите.');
    return;
  }

  console.log('3/3 Създаване…');
  let created = 0, skipped = 0;
  const failed = [];

  for (const code of uniqueCodes) {
    const result = await createAccount(code);
    if (result.ok && result.skipped) { skipped++; continue; }
    if (result.ok) { created++; continue; }
    failed.push({ code, reason: result.reason });
  }

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log(`Създадени:  ${created}`);
  console.log(`Вече съществуват: ${skipped}`);
  console.log(`Неуспешни:  ${failed.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`   ${f.code} — ${f.reason}`));
  }
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log('СЛЕДВАЩА СТЪПКА: качете новия index.html, проверете входа и');
  console.log('едва тогава deploy-нете правилата (firebase deploy --only database).');
}

main().catch((err) => {
  console.error('');
  console.error('❌ Грешка:', err.message);
  process.exit(1);
});
