// Fires ONE dispatcher run against the deployed alert-dispatch function, so a
// real alert reaches a real phone for the first time.
//
//   node tools/send-test-alert.mjs
//
// This is a manual trigger, not the schedule. Nothing in the database calls
// the dispatcher yet — that is deliberate, because the first text a system
// sends should be one somebody is watching for.
//
// WHY THIS SCRIPT EXISTS RATHER THAN A CURL LINE. ALERT_DISPATCH_TOKEN is the
// second factor on a function that spends money sending text messages, and a
// curl command carrying it lands in shell history, in scrollback, and in any
// terminal recording. This reads it from a prompt instead, sends it once, and
// keeps nothing.
//
// THE ANON KEY IS NOT A SECRET. Supabase publishes it to every browser that
// loads the app; the row-level security policies are what protect the data.
// It is read from packages/db/.env.local purely for convenience.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = 'https://lropxenygvybctvaspxm.supabase.co/functions/v1/alert-dispatch';

function readEnv(key) {
  const text = readFileSync(join(HERE, '..', 'packages', 'db', '.env.local'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim().replace(/^"|"$/g, '');
  }
  return undefined;
}

const anonKey = readEnv('SUPABASE_ANON_KEY');
if (!anonKey) {
  console.error('Could not read SUPABASE_ANON_KEY from packages/db/.env.local');
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt) => {
  stdout.write(prompt);
  const { value, done } = await lines.next();
  if (!done) stdout.write('\n');
  return done ? '' : String(value).trim();
};

console.log('\nOverwatch Tally — send one real alert to a real phone\n');
console.log('This WILL send an SMS and WILL cost about a penny.');
console.log('Recipient: the contact stored on Demo Ranch. Limit: 1 alert.\n');

const token = await ask('Paste ALERT_DISPATCH_TOKEN (from your Edge Function secrets): ');
if (token.length < 16) {
  console.error('\nThat looks too short to be the token. Nothing sent.');
  rl.close();
  process.exit(1);
}

const go = await ask('Type SEND to confirm: ');
rl.close();
if (go !== 'SEND') {
  console.log('\nCancelled. Nothing sent.');
  process.exit(0);
}

console.log('\nDispatching...\n');

const res = await fetch(FN, {
  method: 'POST',
  headers: {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'x-alert-dispatch-token': token,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ limit: 1 }),
});

const body = await res.text();
console.log(`HTTP ${res.status}\n${body}\n`);

if (res.status === 401) {
  console.log('401 — the dispatch token does not match the one stored in Edge Function secrets.');
} else if (res.status === 503) {
  console.log('503 — a secret is missing; the body above names which.');
} else if (res.ok) {
  console.log('Look at the `receipts` object above. `sms: 1` means Twilio accepted it.');
  console.log('');
  console.log('IMPORTANT: "accepted" is not "delivered". Carriers filter A2P traffic whose');
  console.log('registered sample messages do not match what actually gets sent, and when they');
  console.log('do it is SILENT — Twilio reports success and the text never lands. If nothing');
  console.log('arrives within a minute, check the message status in the Twilio console rather');
  console.log('than trusting this output.');
}
