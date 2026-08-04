// Mints the two secrets `alert-dispatch` needs that are OURS rather than a
// provider's. Run it locally; nothing leaves this machine and nothing is
// written to disk.
//
//   node tools/mint-dispatch-secrets.mjs
//
// It asks for the project's JWT secret (Supabase Dashboard -> Project Settings
// -> API -> JWT Settings -> JWT Secret), reads it from a prompt rather than a
// command-line argument so it never lands in shell history, and prints the two
// values to paste into Project Settings -> Edge Functions -> Secrets.
//
// WHY A DEDICATED ROLE. ALERT_DISPATCH_JWT carries {"role":"alert_dispatcher"}.
// PostgREST switches into the role named in the token, and migration 0011 gave
// alert_dispatcher EXECUTE on exactly two functions and SELECT on nothing —
// verified: `information_schema.role_table_grants` returns zero rows for it.
// So this token cannot read a customer's herd, feedings, or telemetry even if
// it leaks. That is the whole reason not to reuse the service role key here.
//
// WHY A SEPARATE SHARED TOKEN TOO. Supabase's built-in JWT gate accepts the
// project's ANON key, which is public by design. On a function that spends
// money sending text messages, "presents a valid JWT" is not authorisation.
// ALERT_DISPATCH_TOKEN is the second factor, checked in constant time by the
// function itself.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mintJwt(secret, payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${signature}`;
}

// Pull lines from one iterator rather than calling rl.question() twice.
// readline/promises resolves question() only while the stream is open, so a
// piped stdin (`"secret`n1" | node ...`) answers the first prompt and then
// hangs forever on the second. Iterating handles interactive and piped input
// identically, which also makes this script testable.
const rl = createInterface({ input: stdin, output: stdout });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt) => {
  stdout.write(prompt);
  const { value, done } = await lines.next();
  if (!done) stdout.write('\n');
  return done ? '' : String(value).trim();
};

console.log('\nOverwatch Tally — mint the alert-dispatch secrets');
console.log('Supabase Dashboard -> Project Settings -> API -> JWT Settings -> JWT Secret\n');

const secret = await ask('Paste the JWT secret (input is visible; nothing is saved): ');
if (secret.length < 20) {
  console.error('\nThat does not look like a JWT secret — expected a long random string. Nothing minted.');
  rl.close();
  process.exit(1);
}

const answer = await ask('Expiry in years [1]: ');
const years = answer === '' ? 1 : Number(answer);
if (!Number.isFinite(years) || years <= 0 || years > 10) {
  console.error('\nExpiry must be a number of years between 0 and 10. Nothing minted.');
  rl.close();
  process.exit(1);
}
rl.close();

const now = Math.floor(Date.now() / 1000);
const exp = now + Math.round(years * 365 * 24 * 60 * 60);

const jwt = mintJwt(secret, { role: 'alert_dispatcher', iat: now, exp });

// Prove the signature verifies before handing it over — a token that Supabase
// silently rejects at 3am is worse than no token, and this costs nothing.
const [h, p, s] = jwt.split('.');
const expected = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
const ok =
  s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected));
if (!ok) {
  console.error('\nSelf-check FAILED — the token did not verify against its own secret. Do not use it.');
  process.exit(1);
}

console.log('\n  signature self-check: OK');
console.log(`  expires: ${new Date(exp * 1000).toISOString().slice(0, 10)}  <- put this in your calendar\n`);
console.log('Paste these into Project Settings -> Edge Functions -> Secrets:\n');
console.log(`ALERT_DISPATCH_JWT\n${jwt}\n`);
console.log(`ALERT_DISPATCH_TOKEN\n${randomBytes(32).toString('hex')}\n`);
console.log('Then close this terminal. Do not paste either value into a chat, a commit, or a log.\n');
