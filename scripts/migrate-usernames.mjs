#!/usr/bin/env node
/**
 * migrate-usernames.mjs — преминаване от 6-цифрени кодове към потребителско име + парола.
 *
 * ПРЕДИ: входът беше с 6-цифрен код. Firebase Auth използваше вътрешен имейл
 * `{код}@physiobook.eu` с парола самия код. Всеки човек имаше по няколко записа
 * в базата (по един на код) и по няколко Auth акаунта.
 *
 * СЛЕД: входът е с потребителско име; имейлът е `{име}@physiobook.eu`.
 * Един човек = един Auth акаунт = един запис във всяка клиника.
 *
 * Скриптът:
 *   1. прави ПЪЛНО резервно копие (база + Auth акаунти);
 *   2. преименува Auth акаунтите и им задава новата парола;
 *   3. изтрива дублиращите се Auth акаунти от стария модел;
 *   4. слива дублиращите се потребителски записи в рамките на клиника
 *      (пренасочва препратките `createdBy` и т.н. към запазения запис);
 *   5. записва `username` върху всеки запис, който е имал `accessCode`;
 *   6. ПРЕМАХВА `accessCode` от базата — иначе всеки автентикиран потребител
 *      можеше да прочете паролите (правилата на RTDB дават четене на цялата
 *      клиника на всеки влязъл);
 *   7. записва `adminUsername` в корена на всяка клиника.
 *
 * ИЗПОЛЗВАНЕ
 *   node scripts/migrate-usernames.mjs                      # сухо изпълнение (нищо не се пише)
 *   node scripts/migrate-usernames.mjs --apply              # реално изпълнение
 *   node scripts/migrate-usernames.mjs --apply --skip-auth  # само базата, без Auth
 *
 * Ключът на service account се търси в:
 *   $FIREBASE_SA_KEY  →  ~/Downloads/physiobook-d6eff-firebase-adminsdk-*.json
 * НИКОГА не се качва в репото.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// ПЛАН НА МИГРАЦИЯТА
//
// ⚠️ СЕКРЕТИТЕ НЕ ЖИВЕЯТ В ТОВА РЕПО.
// Репото е ПУБЛИЧНО. Ако тук имаше реални пароли и стари кодове, всеки щеше
// да влезе като администратор. Затова идентичностите се четат отвън:
//
//   1. MIGRATION_IDENTITIES_JSON — път до файл ИЛИ самият JSON наведнъж; или
//   2. scripts/migrate-usernames.identities.json — локален файл (в .gitignore).
//
// Ако нито едно от двете не е налично, скриптът СПИРА, без да пише нищо.
//
// Един човек = един вход. Затова всички негови стари кодове сочат към едно
// потребителско име, а излишните Auth акаунти се изтриват.
//
// Формат на файла:
//   [
//     { "display": "Име Фамилия", "username": "ime.familiya", "password": "…",
//       "codes": ["123456", "654321"], "keepAuth": "123456",
//       "roles": ["Кинезитерапевт", "Администратор"] }
//   ]
// ─────────────────────────────────────────────────────────────────────────────
const IDENTITIES_PATH = path.join(import.meta.dirname, 'migrate-usernames.identities.json');

function loadIdentities() {
  let raw = process.env.MIGRATION_IDENTITIES_JSON || null;
  if (raw && !raw.trim().startsWith('[')) {
    // Третираме го като път до файл.
    if (!fs.existsSync(raw)) {
      console.error(`\n✗ MIGRATION_IDENTITIES_JSON сочи към несъществуващ файл: ${raw}\n`);
      process.exit(1);
    }
    raw = fs.readFileSync(raw, 'utf8');
  }
  if (!raw && fs.existsSync(IDENTITIES_PATH)) raw = fs.readFileSync(IDENTITIES_PATH, 'utf8');

  if (!raw) {
    console.error('\n✗ Липсват идентичности за миграцията.\n');
    console.error('  Създай scripts/migrate-usernames.identities.json (той е в .gitignore)');
    console.error('  или подай MIGRATION_IDENTITIES_JSON=<път|JSON> в средата.\n');
    console.error('  ⚠️ Файлът НЕ бива да се качва в репото — съдържа реални пароли.\n');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('\n✗ Невалиден JSON в идентичностите:', e.message, '\n');
    process.exit(1);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error('\n✗ Идентичностите трябва да са непразен масив.\n');
    process.exit(1);
  }
  parsed.forEach((it, i) => {
    const ok = it && typeof it.username === 'string' && typeof it.password === 'string'
      && Array.isArray(it.codes) && it.codes.length > 0;
    if (!ok) {
      console.error(`\n✗ Непълна идентичност №${i + 1}: нужно е username, password и непразен codes.\n`);
      process.exit(1);
    }
  });
  return parsed;
}

const IDENTITIES = loadIdentities();

// Къде в базата живеят записи с `accessCode`. Обхождат се рекурсивно.
const ROOTS = ['admins', 'superAdmins', 'clinics', 'users', 'patients'];

// ─────────────────────────────────────────────────────────────────────────────
// Инфраструктура
// ─────────────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply');
const SKIP_AUTH = process.argv.includes('--skip-auth');

function findKeyPath() {
  if (process.env.FIREBASE_SA_KEY) return process.env.FIREBASE_SA_KEY;
  const dir = path.join(process.env.HOME, 'Downloads');
  const hit = fs.readdirSync(dir).find(f => /^physiobook-.*-firebase-adminsdk-.*\.json$/.test(f));
  if (!hit) throw new Error('Не намирам service account ключ. Задай $FIREBASE_SA_KEY.');
  return path.join(dir, hit);
}

const KEY_PATH = findKeyPath();
const SA = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
const PROJECT = SA.project_id;
const DB_URL = `https://${PROJECT}-default-rtdb.europe-west1.firebasedatabase.app`;

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ВАЖНО: за Realtime Database REST е нужен точно scope-ът `firebase.database`.
// Само с `cloud-platform` + `firebase` сървърът отговаря „Unauthorized request.".
async function getAccessToken(scopes = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/firebase',
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
]) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: SA.private_key_id };
  const payload = {
    iss: SA.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(SA.private_key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Token error: ${JSON.stringify(body)}`);
  return body.access_token;
}

let TOKEN = null;
const authHeader = () => ({ Authorization: `Bearer ${TOKEN}` });

async function dbGet(p) {
  const r = await fetch(`${DB_URL}/${p}.json`, { headers: authHeader() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${p} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function dbPatch(p, obj) {
  const r = await fetch(`${DB_URL}/${p}.json`, {
    method: 'PATCH',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error(`PATCH ${p} → ${r.status} ${await r.text()}`);
  return r.json();
}

async function dbDelete(p) {
  const r = await fetch(`${DB_URL}/${p}.json`, { method: 'DELETE', headers: authHeader() });
  if (!r.ok) throw new Error(`DELETE ${p} → ${r.status} ${await r.text()}`);
  return true;
}

async function identityToolkit(endpoint, body, method = 'POST') {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/${endpoint}`, {
    method,
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!r.ok) throw new Error(`${endpoint} → ${r.status} ${text}`);
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Обхождане на базата
// ─────────────────────────────────────────────────────────────────────────────

// [{ path, code, name, roles, protected }] за всеки запис с `accessCode`.
function collectCodeRecords(node, path = '') {
  const out = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  if (typeof node.accessCode === 'string' && /^\d{6}$/.test(node.accessCode)) {
    out.push({
      path,
      code: node.accessCode,
      name: node.name || '(без име)',
      roles: node.roles || (node.role ? [node.role] : []),
      protected: node.protected === true,
      keys: Object.keys(node),   // за проверка след записа, че нищо не е изчезнало
    });
  }
  for (const [k, v] of Object.entries(node)) {
    out.push(...collectCodeRecords(v, path ? `${path}/${k}` : k));
  }
  return out;
}

// Всички пътища в поддърво, чиято СТОЙНОСТ е точно `value` (низ).
// `skipPath` се пропуска (записът, който ще бъде изтрит).
// Пътищата са масиви от стъпки — така работят и индексите на масиви.
function findValuePaths(node, value, skipPath = null, path = []) {
  const out = [];
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => out.push(...findValuePaths(v, value, skipPath, [...path, i])));
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = [...path, k];
      if (p.join('/') === skipPath) continue;
      out.push(...findValuePaths(v, value, skipPath, p));
    }
    return out;
  }
  if (node === value) out.push(path);
  return out;
}

// Проверява на жив възел, че PATCH с този buildPatch НЕ изтрива съседни полета.
// Ако някога Firebase промени семантиката, миграцията ще спре преди да пише.
async function assertPatchMerges() {
  const probe = `zzMigrationSelfTest/${Date.now()}`;
  const original = { keep1: 'a', keep2: 42, nested: { inner: 'x' } };
  try {
    await fetch(`${DB_URL}/${probe}.json`, {
      method: 'PUT', headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...original, nested: { ...original.nested, drop: true } }),
    });
    const body = buildPatch([
      { path: ['added'], value: 'new' },
      { path: ['nested', 'drop'], value: null },
      { path: ['nested', 'added'], value: 'y' },
    ]);
    const r = await fetch(`${DB_URL}/${probe}.json`, {
      method: 'PATCH', headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH ${r.status}`);
    const got = await dbGet(probe);
    const okAll = got && got.keep1 === 'a' && got.keep2 === 42
      && got.nested?.inner === 'x' && got.nested?.added === 'y'
      && !('drop' in (got.nested || {})) && got.added === 'new';
    if (!okAll) {
      throw new Error(
        'PATCH не слива правилно — съседните полета се губят.\n' +
        `  изпратено: ${JSON.stringify(body)}\n` +
        `  получено:  ${JSON.stringify(got)}\n` +
        '  Миграцията е СПРЯНА, за да не се загубят данни.');
    }
  } finally {
    await fetch(`${DB_URL}/zzMigrationSelfTest.json`, { method: 'DELETE', headers: authHeader() }).catch(() => {});
  }
}

// Сглобява тяло за multi-path update от списък [{ path: ['a','b',0], value }].
//
// ⚠️ ВАЖНО: REST PATCH на RTDB НЕ слива вложени обекти — всяко дете, чиято
// стойност в тялото е обект, ЗАМЕСТВА съответния възел (проверено емпирично).
// Затова НЕ бива да се праща вложено тяло като {users:{u1:{x:1}}} — то щеше да
// изтрие всичко останало в users/u1 и всички други потребители.
// Истинският multi-path update използва ПЛОСКИ ключове с наклонени черти:
// { 'users/u1/x': 1, 'patients/p1/y': 2 }. Така всяко поле се пише поотделно.
function buildPatch(entries) {
  const body = {};
  for (const { path: steps, value } of entries) {
    body[steps.join('/')] = value;
  }
  return body;
}

// ─────────────────────────────────────────────────────────────────────────────
// Основен поток
// ─────────────────────────────────────────────────────────────────────────────

const line = (s = '') => process.stdout.write(`${s}\n`);
const head = (s) => line(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s) => line(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => line(`  \x1b[33m!\x1b[0m ${s}`);

async function main() {
  line('\x1b[36m═══ Миграция към потребителско име + парола ═══\x1b[0m');
  line(`Проект: ${PROJECT}`);
  line(`Режим:  ${APPLY ? '\x1b[31mПРИЛАГАНЕ (пише се!)\x1b[0m' : '\x1b[33mСУХО ИЗПЪЛНЕНИЕ (нищо не се пише)\x1b[0m'}`);
  if (SKIP_AUTH) line('        Auth акаунтите НЯМА да се пипат (--skip-auth)');

  TOKEN = await getAccessToken();

  // ── 1. Четене на базата ──────────────────────────────────────────────────
  const snapshot = {};
  for (const root of ROOTS) snapshot[root] = await dbGet(root);

  const records = [];
  for (const root of ROOTS) records.push(...collectCodeRecords(snapshot[root], root));

  const codeToUsername = new Map();
  const problems = [];
  for (const ident of IDENTITIES) {
    for (const c of ident.codes) codeToUsername.set(c, ident.username);
  }

  head('1. Записи с 6-цифрен код');
  const byCode = new Map();
  for (const r of records) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code).push(r);
  }
  for (const code of [...byCode.keys()].sort()) {
    const list = byCode.get(code);
    const uname = codeToUsername.get(code);
    line(`  ${code} → \x1b[1m${uname || '???'}\x1b[0m  ×${list.length}`);
    for (const r of list) line(`      \x1b[90m${r.path}${r.protected ? '  [защитен]' : ''}\x1b[0m`);
    if (!uname) problems.push(`Код ${code} има записи в базата, но липсва в IDENTITIES.`);
  }

  // ── 2. Auth акаунти ──────────────────────────────────────────────────────
  const authList = await identityToolkit('accounts:batchGet?maxResults=1000', null, 'GET');
  const authUsers = authList.users || [];
  const authByCode = new Map();
  const authByEmail = new Map();
  for (const u of authUsers) {
    const m = /^(\d{6})@/.exec(u.email || '');
    if (m) authByCode.set(m[1], u);
    if (u.email) authByEmail.set(u.email, u);
  }

  head('2. Firebase Auth акаунти');
  line(`  общо: ${authUsers.length}`);
  for (const u of authUsers) {
    const m = /^(\d{6})@/.exec(u.email || '');
    line(`  ${m ? '  ' : '\x1b[33m?\x1b[0m '}${u.email}${m ? `  (код ${m[1]})` : '  \x1b[33m← не е код-акаунт\x1b[0m'}`);
  }

  // ── 3. Auth операции ─────────────────────────────────────────────────────
  const authRenames = [];  // { from, to, password, localId }
  const authDeletes = [];  // { code, localId }

  head(`3. Auth: какво ще се промени${SKIP_AUTH ? ' \x1b[33m(пропуснато)\x1b[0m' : ''}`);
  for (const ident of IDENTITIES) {
    if (SKIP_AUTH) {
      // Auth вече е мигриран при предишен пуск — само проверяваме, че акаунтът е налице.
      const target = `${ident.username}@physiobook.eu`;
      if (!authByEmail.has(target)) problems.push(`Липсва Auth акаунт ${target} (${ident.display}).`);
      else ok(`${target} вече съществува`);
      continue;
    }
    const keepAcc = authByCode.get(ident.keepAuth);
    if (!keepAcc) { problems.push(`Няма Auth акаунт за код ${ident.keepAuth} (${ident.display}).`); continue; }
    authRenames.push({ from: keepAcc.email, to: `${ident.username}@physiobook.eu`, password: ident.password, localId: keepAcc.localId });
    ok(`${keepAcc.email} → \x1b[1m${ident.username}@physiobook.eu\x1b[0m   парола: \x1b[1m${ident.password}\x1b[0m`);
    for (const c of ident.codes) {
      if (c === ident.keepAuth) continue;
      const acc = authByCode.get(c);
      if (acc) { authDeletes.push({ code: c, localId: acc.localId }); line(`      \x1b[90m✕ ${acc.email} — изтрива се (дубликат)\x1b[0m`); }
      else warn(`код ${c} няма Auth акаунт — няма какво да се трие`);
    }
  }

  // ── 4. Сливане на дублиращи се записи в клиниките ────────────────────────
  // В клиника може да има защитен запис „PhysioBook Admin“ и личен запис на
  // същия човек. И двата получават едно и също потребителско име, затова
  // защитеният се изтрива, а препратките към него се пренасочват към личния.
  head('4. Сливане на дублиращи се записи в клиниките');
  const merges = [];   // { clinic, clinicName, dropUid, keepUid, keepName, username, refPaths }
  for (const [cid, clinic] of Object.entries(snapshot.clinics || {})) {
    const users = clinic.users || {};
    const unameOf = (u) => codeToUsername.get(u.accessCode);
    for (const [uid, u] of Object.entries(users)) {
      if (u.protected !== true) continue;
      const uname = unameOf(u);
      if (!uname) continue;
      const keepUid = Object.keys(users).find(k => k !== uid && users[k].protected !== true && unameOf(users[k]) === uname);
      if (!keepUid) { line(`  \x1b[90m${cid} "${clinic.name}" — защитеният „${u.name}“ остава (няма дубликат)\x1b[0m`); continue; }
      const refPaths = findValuePaths(clinic, uid, `users/${uid}`);
      merges.push({ clinic: cid, clinicName: clinic.name || '', dropUid: uid, dropName: u.name, keepUid, keepName: users[keepUid].name, username: uname, refPaths });
      line(`  ${cid} "${clinic.name}"`);
      line(`      \x1b[31m✕ изтрива се\x1b[0m  users/${uid}  „${u.name}“`);
      line(`      \x1b[32m✓ остава\x1b[0m     users/${keepUid}  „${users[keepUid].name}“  → ${uname}`);
      for (const p of refPaths) line(`      \x1b[90m↪ пренасочва се ${p.join('/')}\x1b[0m`);
    }
  }
  if (merges.length === 0) line('  \x1b[90mняма дубликати\x1b[0m');

  // ── 5. Промени в базата ──────────────────────────────────────────────────
  head('5. Потребителски имена в базата');
  const droppedPaths = new Set(merges.map(m => `clinics/${m.clinic}/users/${m.dropUid}`));
  const writes = [];
  for (const r of records) {
    const uname = codeToUsername.get(r.code);
    if (!uname) continue;
    if (droppedPaths.has(r.path)) continue;   // този запис се изтрива — не го обновяваме
    writes.push({ path: r.path, username: uname });
  }
  line(`  записи за обновяване: ${writes.length}`);
  const perUser = {};
  for (const w of writes) (perUser[w.username] ||= []).push(w.path);
  for (const [u, paths] of Object.entries(perUser).sort()) line(`  \x1b[1m${u}\x1b[0m ← ${paths.length} записа`);
  line('  + \x1b[1maccessCode\x1b[0m се ПРЕМАХВА от всички тях (не бива да стои в базата).');

  // ── 6. adminUsername на клиниките ────────────────────────────────────────
  head('6. adminUsername в корена на клиниките');
  const clinicAdmin = {};
  for (const [cid, clinic] of Object.entries(snapshot.clinics || {})) {
    const users = clinic.users || {};
    const after = { ...users };
    for (const m of merges.filter(m => m.clinic === cid)) delete after[m.dropUid];
    for (const m of merges.filter(m => m.clinic === cid)) after[m.keepUid] = { ...after[m.keepUid], protected: true };
    const prot = Object.entries(after).find(([, u]) => u.protected === true && codeToUsername.get(u.accessCode));
    if (prot) {
      const uname = codeToUsername.get(prot[1].accessCode);
      clinicAdmin[cid] = uname;
      ok(`${cid}  "${clinic.name}"  → adminUsername = \x1b[1m${uname}\x1b[0m`);
    } else {
      warn(`${cid}  "${clinic.name}"  → няма защитен администратор, adminUsername не се пипа`);
    }
  }

  // ── Проверки ─────────────────────────────────────────────────────────────
  const usernames = IDENTITIES.map(i => i.username);
  const dups = usernames.filter((u, i) => usernames.indexOf(u) !== i);
  if (dups.length) problems.push(`Дублирани потребителски имена: ${[...new Set(dups)].join(', ')}`);
  for (const i of IDENTITIES) {
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(i.username)) problems.push(`Невалидно потребителско име: ${i.username}`);
    if (String(i.password).length < 6) problems.push(`Твърде кратка парола за ${i.username}`);
  }

  if (problems.length) {
    head('\x1b[31mПРОБЛЕМИ — миграцията НЕ може да продължи\x1b[0m');
    problems.forEach(p => line(`  • ${p}`));
    process.exit(1);
  }

  if (!APPLY) {
    head('\x1b[33mСухо изпълнение — нищо не е променено.\x1b[0m');
    line('  Реално изпълнение:  node scripts/migrate-usernames.mjs --apply');
    return;
  }

  // ── Резервно копие ───────────────────────────────────────────────────────
  head('7. Резервно копие');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(process.cwd(), '.workbuddy-ai', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `usernames-migration-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({
    createdAt: new Date().toISOString(),
    project: PROJECT,
    authAccounts: authUsers,
    database: snapshot,
  }, null, 2));
  ok(backupFile);

  // ── Проверка, че PATCH слива, преди да пишем нещо ────────────────────────
  head('7б. Проверка на механизма за запис');
  await assertPatchMerges();
  ok('PATCH слива съседните полета — може да се пише безопасно');

  // ── Auth ─────────────────────────────────────────────────────────────────
  if (!SKIP_AUTH) {
    head('8. Auth акаунти');
    for (const r of authRenames) {
      await identityToolkit('accounts:update', {
        localId: r.localId, email: r.to, password: r.password, emailVerified: true,
      });
      ok(`${r.from} → ${r.to}`);
    }
    for (const d of authDeletes) {
      await identityToolkit('accounts:delete', { localId: d.localId });
      ok(`изтрит ${d.code}@physiobook.eu`);
    }
  } else {
    head('8. Auth акаунти — ПРОПУСНАТИ (--skip-auth)');
  }

  // ── Сливане в клиниките ──────────────────────────────────────────────────
  head('9. Сливане на записите');
  for (const m of merges) {
    const entries = m.refPaths.map(steps => ({ path: steps, value: m.keepUid }));
    entries.push({ path: ['users', m.keepUid, 'protected'], value: true });
    await dbPatch(`clinics/${m.clinic}`, buildPatch(entries));
    await dbDelete(`clinics/${m.clinic}/users/${m.dropUid}`);
    ok(`${m.clinic}: „${m.dropName}“ → „${m.keepName}“  (${m.refPaths.length} препратки пренасочени)`);
  }
  if (merges.length === 0) line('  \x1b[90mняма какво да се слива\x1b[0m');

  // ── База ─────────────────────────────────────────────────────────────────
  head('10. Запис на потребителските имена');
  for (const w of writes) {
    await dbPatch(w.path, { username: w.username, accessCode: null });
    ok(`${w.path} → ${w.username}`);
  }

  // ── adminUsername ────────────────────────────────────────────────────────
  head('11. adminUsername на клиниките');
  for (const [cid, uname] of Object.entries(clinicAdmin)) {
    await dbPatch(`clinics/${cid}`, { adminUsername: uname, adminCode: null, ownerCode: null });
    ok(`${cid} → ${uname}`);
  }

  // ── Проверка след записа: нищо не бива да е изчезнало ────────────────────
  head('12. Проверка след записа');
  let lost = 0;
  for (const w of writes) {
    const rec = records.find(r => r.path === w.path);
    const now = await dbGet(w.path);
    if (!now) { line(`  \x1b[31m✗ ${w.path} — записът ЛИПСВА\x1b[0m`); lost++; continue; }
    const gone = (rec.keys || []).filter(k => k !== 'accessCode' && !(k in now));
    if (gone.length) { line(`  \x1b[31m✗ ${w.path} — изчезнали полета: ${gone.join(', ')}\x1b[0m`); lost++; }
    if (now.username !== w.username) { line(`  \x1b[31m✗ ${w.path} — username е ${now.username}, очаквано ${w.username}\x1b[0m`); lost++; }
    if (now.accessCode !== undefined) { line(`  \x1b[31m✗ ${w.path} — accessCode още е там\x1b[0m`); lost++; }
  }
  if (lost) {
    line(`\n\x1b[31m${lost} проблема след записа. Възстанови от ${backupFile}\x1b[0m`);
    process.exit(1);
  }
  ok(`${writes.length} записа са обновени без загуба на данни`);

  head('\x1b[32mГотово.\x1b[0m');
  line(`  Резервно копие: ${backupFile}`);
  line('  Влизане: потребителско име + новата парола.');
}

main().catch(err => {
  line(`\n\x1b[31mГРЕШКА: ${err.message}\x1b[0m`);
  process.exit(1);
});
