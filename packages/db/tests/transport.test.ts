/**
 * Tests for the suite's own transport wrapper.
 *
 * These need no database and no credentials, so they run in every `pnpm test`.
 * They exist because `transport.ts` is the one piece of this package that can
 * turn a red run green if it is wrong, and because the stall it now bounds is
 * invisible in a normal run — you only meet it when the network misbehaves at
 * exactly the wrong moment, which is precisely when nobody is watching.
 *
 * The base fetches below reject when their `signal` aborts. That is not a
 * convenience: it is the contract the deadline depends on, and `undici` — the
 * `fetch` Node actually runs — honours it. A base that ignored the signal could
 * not be timed out by anything in this module.
 */

import { describe, expect, it } from 'vitest';
import { retryingFetch, transportEvents, type TransportFetch } from './transport';

const URL_UNDER_TEST = 'https://example.test/rest/v1/farms?org_id=eq.secret';

/** What `fetch` throws when its signal aborts. */
function abortError(): Error {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** What undici throws when the peer resets the connection. */
function connectionReset(): Error {
  const e = new TypeError('fetch failed');
  (e as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), {
    code: 'ECONNRESET',
  });
  return e;
}

interface Spy {
  readonly fetch: TransportFetch;
  calls: number;
}

/** A base that opens a connection and then says nothing, ever. */
function stalling(): Spy {
  const spy: Spy = {
    calls: 0,
    fetch: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        spy.calls += 1;
        const signal = init?.signal ?? null;
        if (!signal) return; // no deadline given: hang forever, like undici would
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
      }),
  };
  return spy;
}

/** A base that behaves differently on each attempt. */
function scripted(steps: readonly (Response | Error | 'stall')[]): Spy {
  const spy: Spy = {
    calls: 0,
    fetch: (_input, init) => {
      const step = steps[spy.calls] ?? steps[steps.length - 1];
      spy.calls += 1;
      if (step === 'stall') {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal ?? null;
          signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      }
      if (step instanceof Error) return Promise.reject(step);
      return Promise.resolve(step as Response);
    },
  };
  return spy;
}

describe('transport wrapper: what it must never retry', () => {
  it.each([200, 401, 403, 404, 409, 429, 500, 502])(
    'returns a delivered %i untouched, on the first attempt',
    async (status) => {
      // The whole safety argument of this module. A status is a verdict from
      // PostgREST — including the 42501 bodies the attack cases assert on — and
      // retrying one would be retrying the assertion.
      const base = scripted([new Response('{}', { status })]);
      const res = await retryingFetch(base.fetch, { attempts: 4 })(URL_UNDER_TEST);
      expect(res.status).toBe(status);
      expect(base.calls, `a delivered ${status} was retried`).toBe(1);
    },
  );

  it.each([503, 520])(
    'returns a delivered %i untouched — the two statuses postgrest-js retries by default',
    async (status) => {
      // @supabase/postgrest-js 2.111 ships `retryEnabled = true` and re-asks
      // GET/HEAD/OPTIONS on exactly these two (RETRYABLE_STATUS_CODES). That is
      // retrying a completed response, which is the thing this module refuses
      // to do — so they are pinned separately from the list above.
      const base = scripted([new Response('{}', { status })]);
      const res = await retryingFetch(base.fetch, { attempts: 4 })(URL_UNDER_TEST);
      expect(res.status).toBe(status);
      expect(base.calls, `a delivered ${status} was retried`).toBe(1);
    },
  );

  it('does not retry a delivered denial on a mutating request', async () => {
    // The cross-tenant write probes assert on this shape: PostgREST answered,
    // the policy said no. A retry here would re-run an attack whose verdict had
    // already been given.
    const base = scripted([new Response('{"code":"42501"}', { status: 403 })]);
    const res = await retryingFetch(base.fetch, { attempts: 4 })(URL_UNDER_TEST, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(403);
    expect(base.calls, 'a delivered 42501 was retried').toBe(1);
  });

  it('rethrows the caller’s own abort without retrying or counting it', async () => {
    const controller = new AbortController();
    controller.abort();
    const base = stalling();
    const before = transportEvents().length;

    await expect(
      retryingFetch(base.fetch, { attempts: 4, attemptTimeoutMs: 5_000 })(URL_UNDER_TEST, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(base.calls, 'a caller abort was retried').toBe(1);
    expect(transportEvents().length - before, 'a caller abort was counted as a network fault').toBe(
      0,
    );
  });
});

describe('transport wrapper: a stall is a transport failure', () => {
  it('fails a stalled request at its own deadline, not at the case timeout', async () => {
    // The 2026-08-04 flake: nothing bounded the socket, so a single stalled GET
    // burned the case's whole 30 s and surfaced as vitest's anonymous timeout.
    const base = stalling();
    const started = Date.now();

    await expect(
      retryingFetch(base.fetch, { attempts: 1, attemptTimeoutMs: 40, callBudgetMs: 10_000 })(
        URL_UNDER_TEST,
      ),
    ).rejects.toMatchObject({ name: 'TransportTimeoutError', code: 'RLS_TRANSPORT_TIMEOUT' });

    expect(Date.now() - started, 'the deadline did not bound the stall').toBeLessThan(2_000);
  });

  it('retries a stall and uses the answer when one finally arrives', async () => {
    const base = scripted(['stall', new Response('{}', { status: 200 })]);
    const res = await retryingFetch(base.fetch, {
      attempts: 4,
      attemptTimeoutMs: 40,
      callBudgetMs: 10_000,
    })(URL_UNDER_TEST);
    expect(res.status).toBe(200);
    expect(base.calls).toBe(2);
  });

  it('gives up inside the call budget when every attempt stalls', async () => {
    // The budget exists so the failure is reported by THIS module — method, URL
    // and cause — while the case still has time to report it.
    const budget = 300;
    const base = stalling();
    const started = Date.now();

    await expect(
      retryingFetch(base.fetch, { attempts: 4, attemptTimeoutMs: 5_000, callBudgetMs: budget })(
        URL_UNDER_TEST,
      ),
    ).rejects.toMatchObject({ name: 'TransportTimeoutError' });

    const elapsed = Date.now() - started;
    expect(elapsed, `spent ${elapsed} ms against a ${budget} ms budget`).toBeLessThan(budget * 4);
  });

  it('retries a rejected POST — setupWorld is almost entirely POST', async () => {
    // RETRY_ALL_METHODS is the one deliberately risky choice in transport.ts:
    // postgrest-js retries GET/HEAD/OPTIONS only, so the ~120 sequential
    // service-role inserts in setupWorld — the calls whose failure reddens all
    // 289 cases from beforeAll — had no retry anywhere before this module.
    const base = scripted([connectionReset(), new Response('{}', { status: 201 })]);
    const res = await retryingFetch(base.fetch, { attempts: 4, attemptTimeoutMs: 5_000 })(
      URL_UNDER_TEST,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(201);
    expect(base.calls).toBe(2);
  });

  it('still retries a connection reset, and recovers', async () => {
    const base = scripted([connectionReset(), new Response('{}', { status: 200 })]);
    const res = await retryingFetch(base.fetch, { attempts: 4, attemptTimeoutMs: 5_000 })(
      URL_UNDER_TEST,
    );
    expect(res.status).toBe(200);
    expect(base.calls).toBe(2);
  });

  it('never logs the query string — org and farm ids live there (hard rule 9)', async () => {
    const base = scripted([connectionReset(), new Response('{}', { status: 200 })]);
    const before = transportEvents().length;
    await retryingFetch(base.fetch, { attempts: 4, attemptTimeoutMs: 5_000 })(URL_UNDER_TEST);
    const logged = transportEvents().slice(before);
    expect(logged.length).toBeGreaterThan(0);
    for (const e of logged) {
      expect(e.url).toBe('https://example.test/rest/v1/farms');
      expect(e.url).not.toContain('secret');
    }
  });

  it('masks ids carried in the path, not just the query string', async () => {
    // The auth admin routes put the subject in the path:
    // DELETE /auth/v1/admin/users/<uuid>. Same rule, different place.
    const userId = 'f624ce09-7fad-4e6e-ad81-b11e8438db72';
    const base = scripted([connectionReset(), new Response('{}', { status: 200 })]);
    const before = transportEvents().length;

    await retryingFetch(base.fetch, { attempts: 4, attemptTimeoutMs: 5_000 })(
      `https://example.test/auth/v1/admin/users/${userId}`,
      { method: 'DELETE' },
    );

    const logged = transportEvents().slice(before);
    expect(logged.length).toBeGreaterThan(0);
    for (const e of logged) {
      expect(e.url).toBe('https://example.test/auth/v1/admin/users/:id');
      expect(e.url).not.toContain(userId);
    }
  });
});
