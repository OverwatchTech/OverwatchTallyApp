// pg.ts — minimal PostgREST client over fetch. Zero dependencies by design:
// the function stays verifiable without the Deno toolchain and ships no npm
// imports. service_role credentials are permitted HERE — mdp-webhook is one
// of exactly two places they may exist (CLAUDE.md #9) — and they bypass RLS,
// which is what lets this function write the ingest tables that have no
// customer policies at all (`ingest_event_ids`, `raw_events`, …).
//
// Error hygiene: PostgREST error bodies can echo row values, so PgError keeps
// only the HTTP status and the SQLSTATE code — safe to log, safe to store.
//
// TIMEOUTS (added 2026-08-03 after the 504 burst — RUNBOOK-INGEST §8): every
// call carries a deadline. Without one, a stalled PostgREST or a lock-blocked
// statement pins the isolate until the platform's 150-second wall clock kills
// it, and a killed isolate runs NO code — not the dead-letter path, not the
// dedup compensation in index.ts. A timeout converts that silent kill into an
// ordinary throw the caller already knows how to handle: the raw-persist
// compensation releases the dedup slot and answers 500, which MDP retries.
// The deadline is therefore a DURABILITY control, not just a latency one.

const DEFAULT_TIMEOUT_MS = 8_000;

export class PgError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    /**
     * True when the request never produced an answer — deadline exceeded or
     * transport failure. `status` is 0 in that case: there was no response to
     * read one from.
     */
    readonly transport: boolean = false,
  ) {
    super(message);
    this.name = 'PgError';
  }

  get isUniqueViolation(): boolean {
    return this.code === '23505' || this.status === 409;
  }
}

export interface PgInsertOptions {
  /** Column list for ON CONFLICT inference, e.g. 'mdp_event_id'. */
  onConflict?: string;
  /** ON CONFLICT DO NOTHING — with `returning`, a duplicate yields []. */
  ignoreDuplicates?: boolean;
  /** ON CONFLICT DO UPDATE (upsert). */
  mergeDuplicates?: boolean;
  /** Ask for the inserted rows back (return=representation). */
  returning?: boolean;
}

export class PostgrestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * The single exit point to the network. Every call gets `timeoutMs`; a
   * deadline miss surfaces as PgError with `transport = true` and `status = 0`.
   * The message never carries the underlying error text — transport failures
   * can quote request bodies back at you, and this module's contract is that a
   * PgError is always safe to log and safe to store (see header).
   */
  private async send(
    url: string,
    init: RequestInit,
    op: string,
    table: string,
  ): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      throw new PgError(
        0,
        null,
        `${op} ${table}: ${timedOut ? `no response within ${this.timeoutMs} ms` : 'transport failure'}`,
        true,
      );
    }
  }

  private headers(prefer: string[]): Record<string, string> {
    const h: Record<string, string> = {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json',
    };
    if (prefer.length > 0) h['Prefer'] = prefer.join(',');
    return h;
  }

  private url(table: string, params?: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}/rest/v1/${table}`);
    for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
    return u.toString();
  }

  private async fail(res: Response, op: string, table: string): Promise<never> {
    let code: string | null = null;
    try {
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code === 'string') code = body.code;
    } catch {
      // body unreadable — status alone tells the story
    }
    throw new PgError(
      res.status,
      code,
      `${op} ${table}: HTTP ${res.status}${code === null ? '' : ` (${code})`}`,
    );
  }

  async insert<T = Record<string, unknown>>(
    table: string,
    rows: Record<string, unknown>[],
    opts: PgInsertOptions = {},
  ): Promise<T[]> {
    const params: Record<string, string> = {};
    if (opts.onConflict !== undefined) params['on_conflict'] = opts.onConflict;
    const prefer = [opts.returning === true ? 'return=representation' : 'return=minimal'];
    if (opts.ignoreDuplicates === true) prefer.push('resolution=ignore-duplicates');
    if (opts.mergeDuplicates === true) prefer.push('resolution=merge-duplicates');
    const res = await this.send(
      this.url(table, params),
      { method: 'POST', headers: this.headers(prefer), body: JSON.stringify(rows) },
      'insert',
      table,
    );
    if (!res.ok) return this.fail(res, 'insert', table);
    if (opts.returning !== true) {
      await res.body?.cancel();
      return [];
    }
    return (await res.json()) as T[];
  }

  /** GET with PostgREST filters (`col: 'eq.value'`), first row or null. */
  async selectOne<T>(table: string, params: Record<string, string>): Promise<T | null> {
    const res = await this.send(
      this.url(table, { ...params, limit: '1' }),
      { method: 'GET', headers: this.headers([]) },
      'select',
      table,
    );
    if (!res.ok) return this.fail(res, 'select', table);
    const rows = (await res.json()) as T[];
    const first = rows[0];
    return first === undefined ? null : first;
  }

  async update(
    table: string,
    patch: Record<string, unknown>,
    filters: Record<string, string>,
  ): Promise<void> {
    const res = await this.send(
      this.url(table, filters),
      { method: 'PATCH', headers: this.headers(['return=minimal']), body: JSON.stringify(patch) },
      'update',
      table,
    );
    if (!res.ok) return this.fail(res, 'update', table);
    await res.body?.cancel();
  }

  async delete(table: string, filters: Record<string, string>): Promise<void> {
    const res = await this.send(
      this.url(table, filters),
      { method: 'DELETE', headers: this.headers(['return=minimal']) },
      'delete',
      table,
    );
    if (!res.ok) return this.fail(res, 'delete', table);
    await res.body?.cancel();
  }
}
