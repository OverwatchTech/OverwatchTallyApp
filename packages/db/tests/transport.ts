/**
 * Transport-layer retry for the RLS attack suite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THIS RETRIES, AND — MUCH MORE IMPORTANTLY — WHAT IT MUST NEVER RETRY.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This suite is the proof that one customer cannot read another's rows. If it
 * reds at random, the run that catches a real leak gets waved through as "just
 * the flake". So the flake has to go. But a retry in the wrong place is far
 * worse than a flake: it would turn a genuine `42501`, a genuine `403`, or a
 * genuine row leak into a green tick.
 *
 * The line this module draws is therefore not "retry transient things". It is:
 *
 *   RETRY ONLY WHEN `fetch` REJECTED — i.e. when no HTTP response exists.
 *   RETURN EVERY RESPONSE THAT ARRIVES, UNTOUCHED, WHATEVER ITS STATUS.
 *
 * A rejected `fetch` means the request never completed a round trip: DNS did
 * not resolve, the TCP/TLS connection never came up, or the socket died before
 * headers came back. There is no verdict in that outcome to mask — PostgREST
 * never spoke. A *resolved* `fetch` is the opposite: the server answered, and
 * that answer IS the thing under test. 200-with-rows, 401, 403, 404, 409 and
 * every PostgREST body carrying `42501` are all policy verdicts, and this
 * module passes all of them straight through to the assertion. Note that this
 * deliberately includes 429 and 5xx: they are not retried here either. If the
 * hosted project starts rate-limiting or 502-ing, the suite must go red and
 * say so, not paper over it — an unexplained 5xx on a probe is a result we
 * need to see, and retrying a 429 would only deepen a rate limit.
 *
 * Nothing here wraps an assertion, a query result, or a status code. The only
 * thing wrapped is the socket.
 *
 * ── Why the suite needs it ───────────────────────────────────────────────────
 *
 * Everything runs against a hosted Supabase project over the public internet,
 * and one run makes several hundred sequential HTTPS calls. `setupWorld` alone
 * makes ~120 back-to-back service-role calls against a project that may have
 * been cold; `@supabase/postgrest-js` ships retry but it is opt-in per query
 * (`.retry(true)`) and would also retry completed responses by status, which
 * is exactly what we must not do; `@supabase/auth-js` has a `retryable()`
 * helper it does not apply to `admin.createUser` / `signInWithPassword` /
 * `admin.deleteUser` at all. So a single dropped connection anywhere in that
 * sequence threw straight out of `beforeAll` and reddened all 289 cases.
 *
 * ── Idempotency of a retried mutation ────────────────────────────────────────
 *
 * `RETRY_ALL_METHODS` below governs whether a rejected POST/PATCH/DELETE is
 * retried. It is on, and it has to be: the fixture setup path — the fragile
 * one, the one that reddens the whole file when it drops — is almost entirely
 * POST. The exposure is a request the server committed whose response was lost
 * on the way back; the retry would then insert a second row. That is bounded
 * and visible rather than silent: every fixture row carries the run's org_id /
 * farm_id, `teardownWorld` deletes by those ids, and its residue check reports
 * anything left. It cannot produce a false GREEN — a duplicate fixture row can
 * only ever make an isolation assertion louder, never quieter.
 *
 * ── A HANG IS A TRANSPORT FAILURE TOO ───────────────────────────────────────
 *
 * Retrying rejections is only half the job, and the missing half reddened a run
 * on 2026-08-04. `undici` bounds nothing that matters here: its headers and body
 * timeouts are 300 s, so a socket that opens and then goes quiet — the classic
 * half-open keep-alive connection that a load balancer has already forgotten —
 * simply stops. Nothing rejects, so nothing above retries.
 *
 * What that looked like: `owner of org B is equally locked out of org A` makes
 * exactly two calls, and its `GET /rest/v1/farms` stalled. Vitest killed the
 * case at its 30 s budget with `Test timed out in 30000ms` — a message that
 * names no URL, no socket and no cause, and points at the isolation assertion
 * rather than at the network. The orphaned request outlived the case: the
 * ECONNRESET landed ~40 s later and got logged against whatever test was
 * running by then, so even the one clue pointed at the wrong case.
 *
 * So every attempt now carries its own deadline, and the call as a whole
 * carries a budget that fits INSIDE the 30 s per-case timeout. A stall becomes
 * a fast, named, retryable rejection instead of a silent 30 s.
 *
 * This does not widen what gets retried. A timed-out attempt is the same
 * outcome as a rejected one — no response reached the assertion, so there is no
 * verdict to mask. The worst case is a response that was genuinely on its way
 * and got abandoned, and that can only ever cost a GREEN: the retry re-asks and
 * uses the fresh answer, and if every attempt stalls the call rejects and the
 * suite goes RED. No stall, at any timing, can turn a leak into a pass.
 *
 * The caller's own `signal` keeps its meaning: an abort the CALLER requested is
 * still fatal, still never retried, still never counted as a transport failure.
 *
 * Every retry prints. A run that needed one says so on stderr, with the error's
 * name, code and cause, so the next person does not have to re-derive what the
 * network did. URLs are logged as origin + pathname only — query strings here
 * carry org and farm ids (hard rule 9).
 */

// packages/db carries no @types/node (see tests/env.ts); `process` is the one
// global this file needs that no lib in the program supplies. `fetch`,
// `Response`, `URL` and `setTimeout` all come from the DOM lib that
// @supabase/supabase-js pulls into the program, and this signature is exactly
// the one `SupabaseClientOptions.global.fetch` expects.
declare const process: { env: Record<string, string | undefined> };

export type TransportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Total attempts per call, including the first. 4 = one try plus three
 * retries. `RLS_TRANSPORT_ATTEMPTS=1` disables retry entirely and leaves the
 * diagnostics on — that is the mode used to characterise a transport failure
 * without a retry hiding it.
 */
export const TRANSPORT_ATTEMPTS: number = (() => {
  const raw = process.env['RLS_TRANSPORT_ATTEMPTS']?.trim();
  if (!raw) return 4;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 4;
})();

/** Reads a positive-integer ms override, or falls back. 0 disables the bound. */
function msEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Deadline for a single attempt, and the one constant here that can do harm if
 * it is wrong: set below the real latency ceiling it would start cutting off
 * healthy calls, which is the old flake wearing new clothes.
 *
 * So it is not asserted from memory. Every run measures its own slowest
 * SUCCESSFUL call and `transportSummary()` prints it with the headroom ratio,
 * green or red. Over the ten consecutive clean runs on 2026-08-04 that signed
 * this off — 819 calls each against the hosted project — the slowest successful
 * call per run was 1166 / 462 / 453 / 1213 / 491 / 606 / 636 / 387 / 640 / 654
 * ms. The worst of them, a POST to feed_schedules at 1213 ms, sits 6.6x inside
 * this deadline. Do not write a number here that no run printed. If the printed
 * number ever climbs towards the deadline, raise THIS, do not raise the vitest
 * timeout: one indexed query needing seconds is telling you about the project,
 * not about the test.
 *
 * 8 s also has to stay an order of magnitude below the 30 s a case may spend,
 * so that a stall is reported by this module — with method, URL and cause —
 * rather than by vitest as an anonymous `Test timed out in 30000ms`.
 * `RLS_TRANSPORT_ATTEMPT_TIMEOUT_MS=0` removes the deadline.
 */
export const ATTEMPT_TIMEOUT_MS: number = msEnv('RLS_TRANSPORT_ATTEMPT_TIMEOUT_MS', 8_000);

/**
 * Ceiling on one logical call, attempts and backoff together. It must stay
 * comfortably under `NET` in rls.test.ts (30 s) so that a network that is
 * simply down fails with THIS module's diagnosis — method, URL, cause — rather
 * than with vitest's anonymous `Test timed out in 30000ms`.
 */
export const CALL_BUDGET_MS: number = msEnv('RLS_TRANSPORT_CALL_BUDGET_MS', 20_000);

/** Backoff before attempt n (1-based retry index), in ms, before jitter. */
const BACKOFF_MS = [250, 750, 2000, 4000] as const;

/** See the idempotency note in the header. */
const RETRY_ALL_METHODS = true;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface ErrorFacts {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly causeName: string;
  readonly causeMessage: string;
  readonly causeCode: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : String(v));

/**
 * Pulls the parts of a fetch rejection that identify it. Node's `fetch`
 * (undici) reports almost everything as a bare `TypeError: fetch failed` and
 * hides the real reason on `.cause` — that is precisely the detail a previous
 * run lost by piping vitest through `grep`.
 */
export function errorFacts(e: unknown): ErrorFacts {
  const err = (e ?? {}) as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown };
  const cause = (err.cause ?? {}) as { name?: unknown; message?: unknown; code?: unknown };
  return {
    name: str(err.name) || 'Error',
    message: str(err.message),
    code: str(err.code),
    causeName: str(cause.name),
    causeMessage: str(cause.message),
    causeCode: str(cause.code),
  };
}

export const describeError = (f: ErrorFacts): string =>
  `${f.name}: ${f.message}${f.code ? ` (${f.code})` : ''}` +
  (f.causeName || f.causeMessage || f.causeCode
    ? ` — caused by ${f.causeName || 'Error'}: ${f.causeMessage}${f.causeCode ? ` (${f.causeCode})` : ''}`
    : ' — no cause attached');

/**
 * An abort the CALLER asked for is the caller's own decision. Never retried,
 * never counted. Our own deadline never reaches here: it is converted into a
 * `TransportTimeoutError` first, precisely so the two cannot be confused.
 */
function isAbort(f: ErrorFacts): boolean {
  return f.name === 'AbortError' || f.code === 'ABORT_ERR' || f.causeCode === 'ABORT_ERR';
}

/**
 * A request that opened and never answered. Deliberately a distinct error, not
 * an `AbortError`: it must read as "the network did not deliver" (retryable,
 * counted, printed) and never as "the caller changed its mind" (fatal).
 */
class TransportTimeoutError extends Error {
  readonly code = 'RLS_TRANSPORT_TIMEOUT';
  constructor(ms: number) {
    super(`no response within ${ms} ms — the request opened and went quiet`);
    this.name = 'TransportTimeoutError';
  }
}

/**
 * One attempt, bounded. Returns whatever the server said; throws
 * `TransportTimeoutError` if the deadline passed with no response, and rethrows
 * the caller's own abort untouched. `deadlineMs <= 0` means unbounded.
 */
async function fetchWithDeadline(
  base: TransportFetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  deadlineMs: number,
): Promise<Response> {
  if (deadlineMs <= 0) return base(input, init);

  const controller = new AbortController();
  const callerSignal = init?.signal ?? null;
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);
  const forwardCallerAbort = (): void => controller.abort();

  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', forwardCallerAbort, { once: true });
  }

  try {
    return await base(input, { ...init, signal: controller.signal });
  } catch (e) {
    // Ours, not theirs: a caller abort that raced the deadline stays the
    // caller's, because their signal is the one that is actually aborted.
    if (timedOut && !callerSignal?.aborted) throw new TransportTimeoutError(deadlineMs);
    throw e;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', forwardCallerAbort);
  }
}

/**
 * How long this attempt may take: the attempt deadline and whatever is left of
 * the call budget, whichever is tighter. 0 when both are disabled.
 */
function attemptDeadline(attemptTimeoutMs: number, remainingMs: number): number {
  const bounds = [attemptTimeoutMs, remainingMs].filter((n) => Number.isFinite(n) && n > 0);
  return bounds.length === 0 ? 0 : Math.max(1, Math.min(...bounds));
}

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

/**
 * origin + pathname, with any id in the path masked.
 *
 * Query strings go entirely: they carry org and farm ids (hard rule 9). The
 * path needs the same treatment for the auth admin routes, which put the
 * subject's user id in the path rather than the query
 * (`DELETE /auth/v1/admin/users/<uuid>`). These lines are what somebody pastes
 * into a ticket when a run goes red, so they name the ROUTE and nothing else.
 */
function safeUrl(input: string | URL | Request): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname.replace(UUID_SEGMENT, '/:id')}`;
  } catch {
    return '<unparseable url>';
  }
}

function methodOf(input: string | URL | Request, init?: RequestInit): string {
  if (typeof init?.method === 'string') return init.method.toUpperCase();
  if (typeof input !== 'string' && !(input instanceof URL)) return input.method.toUpperCase();
  return 'GET';
}

export interface TransportEvent {
  readonly attempt: number;
  readonly attempts: number;
  readonly method: string;
  readonly url: string;
  readonly error: string;
  readonly recovered: boolean;
}

const events: TransportEvent[] = [];

/** Every transport failure this run saw, retried or not. Read by the summary. */
export const transportEvents = (): readonly TransportEvent[] => events;

/**
 * Slowest call that SUCCEEDED this run. `ATTEMPT_TIMEOUT_MS` is only safe while
 * it stays well above this, so the run measures it and prints it rather than
 * anyone asserting it from memory. If this number ever climbs towards the
 * deadline, the deadline is about to start cutting off healthy calls — which
 * would be a new flake wearing the old one's clothes.
 */
let slowestOkMs = 0;
let slowestOkWhat = '<none>';
let callCount = 0;

export const slowestSuccessfulCallMs = (): number => slowestOkMs;

function recordSuccess(ms: number, method: string, url: string): void {
  callCount++;
  if (ms > slowestOkMs) {
    slowestOkMs = ms;
    slowestOkWhat = `${method} ${url}`;
  }
}

export function transportSummary(): string {
  const headroom =
    ATTEMPT_TIMEOUT_MS > 0 && slowestOkMs > 0
      ? `, ${(ATTEMPT_TIMEOUT_MS / slowestOkMs).toFixed(1)}x under the ${ATTEMPT_TIMEOUT_MS} ms attempt deadline`
      : '';
  const pace =
    `[rls] transport: ${callCount} calls, slowest OK ${slowestOkMs} ms ` +
    `(${slowestOkWhat})${headroom}`;

  if (events.length === 0) {
    return `${pace}\n[rls] transport: no connection-level failures this run`;
  }
  const recovered = events.filter((e) => e.recovered).length;
  return [
    pace,
    `[rls] transport: ${events.length} connection-level failure(s), ${recovered} recovered by retry`,
    ...events.map(
      (e) =>
        `        ${e.recovered ? 'recovered' : 'FATAL   '} attempt ${e.attempt}/${e.attempts} ` +
        `${e.method} ${e.url} — ${e.error}`,
    ),
  ].join('\n');
}

/**
 * The three numbers that bound a call. Injectable so the tests can drive the
 * wrapper at millisecond scale; the defaults are the env-derived constants
 * above and are what every client in the suite actually runs with.
 */
export interface TransportLimits {
  readonly attempts: number;
  readonly attemptTimeoutMs: number;
  readonly callBudgetMs: number;
}

/**
 * Wraps a fetch so that connection-level rejections AND stalls are retried with
 * bounded exponential backoff. Resolved responses are returned untouched — see
 * header.
 */
export function retryingFetch(
  base: TransportFetch = fetch,
  limits: Partial<TransportLimits> = {},
): TransportFetch {
  const attempts = limits.attempts ?? TRANSPORT_ATTEMPTS;
  const attemptTimeoutMs = limits.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const callBudgetMs = limits.callBudgetMs ?? CALL_BUDGET_MS;

  return async function transportFetch(input, init) {
    const method = methodOf(input, init);
    const retryThisMethod = RETRY_ALL_METHODS || SAFE_METHODS.has(method);

    const startedAt = Date.now();
    const remaining = (): number =>
      callBudgetMs > 0 ? callBudgetMs - (Date.now() - startedAt) : Number.POSITIVE_INFINITY;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptStartedAt = Date.now();
      try {
        // The ONLY awaited call. Whatever it resolves to — 200, 403, 429,
        // 500, a PostgREST 42501 body — is returned as-is, immediately.
        const res = await fetchWithDeadline(
          base,
          input,
          init,
          attemptDeadline(attemptTimeoutMs, remaining()),
        );
        recordSuccess(Date.now() - attemptStartedAt, method, safeUrl(input));
        return res;
      } catch (e) {
        lastError = e;
        const facts = errorFacts(e);
        if (isAbort(facts)) throw e;

        const baseMs = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 2000;
        // ±25% jitter: several clients in this suite fail together on a cold
        // project, and lock-step retries would hit it as one burst.
        const backoffMs = Math.round(baseMs * (0.75 + Math.random() * 0.5));

        // Stop while there is still room to report: a retry that would run past
        // the budget is a retry whose failure vitest would report as its own
        // anonymous 30 s timeout instead of as the network fault it is.
        const outOfBudget = backoffMs >= remaining();
        const canRetry = retryThisMethod && attempt < attempts && !outOfBudget;

        events.push({
          attempt,
          attempts,
          method,
          url: safeUrl(input),
          error: describeError(facts),
          recovered: canRetry,
        });
        console.warn(
          `[rls] transport ${canRetry ? 'retry' : 'FAILED'} — ` +
            `attempt ${attempt}/${attempts} ${method} ${safeUrl(input)}` +
            (outOfBudget ? ` — gave up: ${callBudgetMs} ms call budget spent` : '') +
            `\n        ${describeError(facts)}`,
        );
        if (!canRetry) throw e;

        await sleep(backoffMs);
      }
    }
    // Unreachable: the final attempt either returns or rethrows above.
    throw lastError;
  };
}

/** The single shared instance; every client in the suite uses this one. */
export const suiteFetch: TransportFetch = retryingFetch();
