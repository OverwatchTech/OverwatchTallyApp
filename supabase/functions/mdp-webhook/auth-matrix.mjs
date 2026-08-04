// auth-matrix.mjs — prove the ingest endpoint's authentication, against the
// DEPLOYED function, from outside.
//
//   node supabase/functions/mdp-webhook/auth-matrix.mjs [farm_id]
//
// Written for migration 0022, which took the per-farm token out of the URL.
// The case that matters is the first one: post to an old token-bearing URI
// with no signature headers — which is exactly what someone who read a farm
// token out of Supabase's platform edge log can do. It used to be a 200.
//
// Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from packages/db/.env.local
// and the farm's signing material from the database. Prints statuses and
// event ids only: never the service key, never the webhook secret, never the
// farm token.
//
// Side effects: three accepted deliveries land in raw_events under event ids
// prefixed `authmatrix-`. They carry an unknown devEUI on purpose, so they are
// dropped at normalization and no readings are written.

import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FARM = process.argv[2] ?? '22222222-2222-4222-8222-222222222222';

const env = Object.fromEntries(
  readFileSync(`${ROOT}packages/db/.env.local`, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
);
const BASE = env.SUPABASE_URL.replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function rest(path) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`rest ${path}: HTTP ${res.status}`);
  return res.json();
}

const [creds] = await rest(
  `mdp_webhook_credentials?select=webhook_uuid,webhook_secret&farm_id=eq.${FARM}`,
);
if (!creds) {
  console.error(`No mdp_webhook_credentials row for farm ${FARM} — it cannot ingest at all.`);
  process.exit(2);
}
const [farm] = await rest(`farms?select=name,webhook_token&id=eq.${FARM}`);

const TOKENLESS = `${BASE}/functions/v1/mdp-webhook`;
const LEGACY = `${TOKENLESS}/${farm.webhook_token}`;

/** The four headers MDP sends. `skew` shifts the timestamp to force staleness. */
function signed({ uuid = creds.webhook_uuid, secret = creds.webhook_secret, skew = 0 } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000) + skew);
  const nonce = randomUUID().replace(/-/g, '');
  return {
    'content-type': 'application/json',
    'x-msc-webhook-uuid': uuid,
    'x-msc-request-nonce': nonce,
    'x-msc-request-timestamp': timestamp,
    'x-msc-request-signature': createHmac('sha256', secret)
      .update(`${timestamp}${nonce}`)
      .digest('hex'),
  };
}

const RUN = randomUUID().slice(0, 8);
let seq = 0;
/** A one-element batch, shaped exactly like a real MDP delivery. */
function envelope() {
  seq += 1;
  return JSON.stringify([
    {
      eventId: `authmatrix-${RUN}-${seq}`,
      eventCreatedTime: String(Math.floor(Date.now() / 1000)),
      eventVersion: '1.0',
      eventType: 'DEVICE_DATA',
      data: {
        deviceProfile: { devEUI: 'DEMO_00000001', model: 'EM400-UDL' },
        type: 'PROPERTY',
        tslID: '',
        payload: { battery: 91, temperature: 12.5, distance: 640, position: 'normal' },
      },
    },
  ]);
}

const results = [];
async function probe(name, expect, url, { headers = {}, method = 'POST' } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : envelope(),
  });
  await res.body?.cancel();
  results.push({ name, expect, got: res.status, pass: res.status === expect });
}

// ── what a log reader can do ────────────────────────────────────────────────
await probe('token URL from the log, NO signature', 401, LEGACY, {
  headers: { 'content-type': 'application/json' },
});
await probe('token URL + forged signature', 401, LEGACY, {
  headers: signed({ secret: 'not-the-secret' }),
});
await probe('unknown webhook uuid', 401, TOKENLESS, {
  headers: signed({ uuid: '00000000-0000-4000-8000-000000000000' }),
});
await probe('captured headers replayed late', 401, TOKENLESS, { headers: signed({ skew: -3600 }) });
await probe('tokenless URL, NO signature', 401, TOKENLESS, {
  headers: { 'content-type': 'application/json' },
});

// ── what MDP does ───────────────────────────────────────────────────────────
await probe('SIGNED, tokenless URL (canonical)', 200, TOKENLESS, { headers: signed() });
await probe('SIGNED, legacy token URL', 200, LEGACY, { headers: signed() });
await probe('SIGNED, wrong token in path', 200, `${TOKENLESS}/${'f'.repeat(48)}`, {
  headers: signed(),
});
await probe('GET liveness probe', 200, TOKENLESS, { method: 'GET' });

const width = Math.max(...results.map((r) => r.name.length));
console.log(`farm: ${farm.name} (${FARM})\n`);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  expect ${r.expect}  got ${r.got}`);
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);

// Do not take "200" on trust — show what actually landed.
const rows = await rest(
  `raw_events?select=mdp_event_id,event_type,status&mdp_event_id=like.authmatrix-${RUN}-*&order=mdp_event_id`,
);
console.log(`\nraw_events written by this run (${rows.length}, expected 3):`);
for (const row of rows) console.log(`  ${row.mdp_event_id}  ${row.event_type}  ${row.status}`);

process.exit(failed === 0 && rows.length === 3 ? 0 : 1);
