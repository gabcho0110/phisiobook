#!/usr/bin/env node
/**
 * ============================================================================
 * PhysioBook — качване на правилата за Realtime Database
 * ============================================================================
 *
 * Използва Firebase Rules REST endpoint-а (`.settings/rules.json`) и
 * service account ключ. Не е нужен firebase CLI.
 *
 * УПОТРЕБА:
 *   node scripts/deploy-rules.mjs --key <ключ>.json            # показва разликата
 *   node scripts/deploy-rules.mjs --key <ключ>.json --apply    # качва
 *
 * ⚠️  ВАЖНО: качете правилата САМО след като новите index.html и admin.html
 *     са на живо. Старата версия не се автентикира и входът ще спре.
 * ============================================================================
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const PROJECT_ID = 'physiobook-d6eff';
const DB_URL = `https://${PROJECT_ID}-default-rtdb.europe-west1.firebasedatabase.app`;
const RULES_FILE = path.join(process.cwd(), 'database.rules.json');

const APPLY = process.argv.includes('--apply');
const keyIdx = process.argv.indexOf('--key');
const KEY_PATH = keyIdx >= 0 ? process.argv[keyIdx + 1] : process.env.GOOGLE_APPLICATION_CREDENTIALS;

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const sa = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id }))}.${b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
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

async function main() {
  if (!KEY_PATH) throw new Error('Липсва --key <път до service account json>');
  if (!fs.existsSync(RULES_FILE)) throw new Error(`Не намирам ${RULES_FILE}`);

  const desired = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  const token = await getAccessToken();
  const url = `${DB_URL}/.settings/rules.json?access_token=${token}`;

  const currentRes = await fetch(url);
  const current = await currentRes.json();

  console.log('Текущи правила:');
  console.log(JSON.stringify(current, null, 2));
  console.log('');
  console.log('Нови правила:');
  console.log(JSON.stringify(desired, null, 2));
  console.log('');

  if (!APPLY) {
    console.log('dry-run — нищо не е променено. Добавете --apply, за да качите.');
    return;
  }

  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(desired)
  });
  console.log('PUT .settings/rules.json →', putRes.status);
  if (!putRes.ok) {
    console.log((await putRes.text()).slice(0, 500));
    process.exit(1);
  }

  const verify = await (await fetch(url)).json();
  console.log('');
  console.log('✓ Правилата са качени. Проверка:');
  console.log(JSON.stringify(verify, null, 2));
}

main().catch((err) => {
  console.error('');
  console.error('❌ Грешка:', err.message);
  process.exit(1);
});
