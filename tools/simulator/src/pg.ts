// A thin PostgREST client for the simulator, shaped like the one the edge
// function uses (supabase/functions/mdp-webhook/pg.ts) so the two agree on
// conflict handling and error surfacing.
//
// service_role is used here on purpose: this is local operator tooling, not
// `apps/web` (CLAUDE.md #9). Nothing in this file logs a key.

import { WRITE_BATCH } from './config.ts';

// NOTE: no TypeScript parameter properties anywhere in this package. Node
// runs these files with strip-only type stripping, which rejects them
// (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX) — same reason there are no enums.

export class PgError extends Error {
  readonly status: number;
  readonly table: string;
  readonly op: string;
  readonly body: string;

  constructor(status: number, table: string, op: string, body: string) {
    super(`${op} ${table} failed: ${status} ${body.slice(0, 300)}`);
    this.name = 'PgError';
    this.status = status;
    this.table = table;
    this.op = op;
    this.body = body;
  }

  /** A schema change landing underneath us looks like one of these. */
  get looksLikeSchemaChange(): boolean {
    return (
      this.status === 404 ||
      this.status === 409 ||
      /PGRST20[0-9]|schema cache|does not exist|undefined column/i.test(this.body)
    );
  }

  /**
   * `readings` and `raw_events` are range-partitioned by month, and
   * `app.ensure_month_partitions` only ever creates partitions FORWARD (the
   * cron job runs monthly for the current month plus three). Backfilling into
   * a month before the database was stood up therefore has nowhere to land.
   * That is a normal thing to hit and deserves a normal answer, not a raw
   * 23514.
   */
  get isMissingPartition(): boolean {
    return /no partition of relation/i.test(this.body);
  }

  /** The month a failing row needed, as `YYYYMM`, when the error names it. */
  get missingPartitionMonth(): string | null {
    const m = /\(received_at\) = \((\d{4})-(\d{2})-/.exec(this.body);
    return m === null ? null : `${m[1]}${m[2]}`;
  }
}

/** Actionable text for a missing-partition failure — SQL the operator can run. */
export function missingPartitionHelp(err: PgError): string {
  const month = err.missingPartitionMonth;
  const label = month ?? 'YYYYMM';
  const first =
    month === null ? 'YYYY-MM-01' : `${month.slice(0, 4)}-${month.slice(4)}-01`;
  return [
    `${err.table} has no partition covering the requested window.`,
    '',
    'Monthly partitions are created forward only (app.ensure_month_partitions),',
    'so a backfill reaching before the database was stood up has nowhere to put',
    'its rows. Either shorten the window, or create the partition first — using',
    'the repo\'s own helper so RLS and the realtime publication are applied:',
    '',
    `  create table ${err.table}_${label} partition of ${err.table}`,
    `    for values from ('${first}') to ('${first}'::date + interval '1 month');`,
    `  select app.secure_time_partition('${err.table}_${label}', '${err.table}');`,
    err.table === 'readings'
      ? `  select app.publish_readings_partition('${err.table}_${label}');`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export interface InsertOptions {
  onConflict?: string;
  ignoreDuplicates?: boolean;
  mergeDuplicates?: boolean;
  returning?: boolean;
}

export class Pg {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(baseUrl: string, serviceRoleKey: string) {
    this.baseUrl = baseUrl;
    this.serviceRoleKey = serviceRoleKey;
  }

  private headers(prefer: readonly string[]): Record<string, string> {
    const h: Record<string, string> = {
      apikey: this.serviceRoleKey,
      Authorization: `Bearer ${this.serviceRoleKey}`,
      'Content-Type': 'application/json',
    };
    if (prefer.length > 0) h['Prefer'] = prefer.join(',');
    return h;
  }

  private url(table: string, params: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}/rest/v1/${table}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  /**
   * A thirty-day backfill is a few hundred round trips over several minutes,
   * and one dropped socket should not throw the whole run away. Transport
   * failures and 5xx / 429 are retried with backoff; a 4xx is a real answer
   * and is returned as-is for the caller to deal with.
   */
  private async request(url: string, init: RequestInit, attempts = 4): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
      try {
        const res = await fetch(url, init);
        if (res.status < 500 && res.status !== 429) return res;
        await res.body?.cancel();
        lastError = new Error(`upstream ${res.status}`);
        if (attempt === attempts - 1) return fetch(url, init);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async select<T>(table: string, params: Record<string, string>): Promise<T[]> {
    const res = await this.request(this.url(table, params), { headers: this.headers([]) });
    if (!res.ok) throw new PgError(res.status, table, 'select', await res.text());
    return (await res.json()) as T[];
  }

  /** Exact row count via `Prefer: count=exact` — the Content-Range tail. */
  async count(table: string, params: Record<string, string> = {}): Promise<number> {
    const res = await this.request(this.url(table, { ...params, select: 'count' }), {
      headers: this.headers(['count=exact', 'head=true']),
    });
    if (!res.ok) throw new PgError(res.status, table, 'count', await res.text());
    await res.body?.cancel();
    const range = res.headers.get('content-range') ?? '';
    const total = Number(range.split('/')[1]);
    return Number.isFinite(total) ? total : 0;
  }

  async insert<T = Record<string, unknown>>(
    table: string,
    rows: readonly Record<string, unknown>[],
    opts: InsertOptions = {},
  ): Promise<T[]> {
    if (rows.length === 0) return [];
    const params: Record<string, string> = {};
    if (opts.onConflict !== undefined) params['on_conflict'] = opts.onConflict;
    const prefer = [opts.returning === true ? 'return=representation' : 'return=minimal'];
    if (opts.ignoreDuplicates === true) prefer.push('resolution=ignore-duplicates');
    if (opts.mergeDuplicates === true) prefer.push('resolution=merge-duplicates');
    const res = await this.request(this.url(table, params), {
      method: 'POST',
      headers: this.headers(prefer),
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new PgError(res.status, table, 'insert', await res.text());
    if (opts.returning !== true) {
      await res.body?.cancel();
      return [];
    }
    return (await res.json()) as T[];
  }

  /** Inserts in `WRITE_BATCH`-sized chunks; returns the number of rows sent. */
  async insertBatched(
    table: string,
    rows: readonly Record<string, unknown>[],
    opts: InsertOptions = {},
  ): Promise<number> {
    for (let i = 0; i < rows.length; i += WRITE_BATCH) {
      await this.insert(table, rows.slice(i, i + WRITE_BATCH), opts);
    }
    return rows.length;
  }

  async update(
    table: string,
    patch: Record<string, unknown>,
    filters: Record<string, string>,
  ): Promise<void> {
    const res = await this.request(this.url(table, filters), {
      method: 'PATCH',
      headers: this.headers(['return=minimal']),
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new PgError(res.status, table, 'update', await res.text());
    await res.body?.cancel();
  }

  async delete(table: string, filters: Record<string, string>): Promise<void> {
    const res = await this.request(this.url(table, filters), {
      method: 'DELETE',
      headers: this.headers(['return=minimal']),
    });
    if (!res.ok) throw new PgError(res.status, table, 'delete', await res.text());
    await res.body?.cancel();
  }
}

/**
 * Runs `work`, and on a failure that looks like a migration landing
 * underneath us, waits and tries exactly once more (the brief's sequencing
 * note — another agent owns the schema right now). Anything else rethrows
 * immediately: a real bug should not be papered over by a retry.
 */
export async function retryOnSchemaChange<T>(
  work: () => Promise<T>,
  waitMs = 8_000,
  log: (msg: string) => void = () => {},
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof PgError) || !err.looksLikeSchemaChange) throw err;
    log(`schema-shaped failure (${err.status}); waiting ${waitMs / 1000}s and retrying once`);
    await new Promise((r) => setTimeout(r, waitMs));
    return work();
  }
}
