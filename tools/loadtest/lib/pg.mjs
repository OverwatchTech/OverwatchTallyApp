// pg.mjs — the smallest PostgREST client that can build a farm and count rows.
//
// Deliberately the same shape as supabase/functions/mdp-webhook/pg.ts: fetch,
// no dependencies. This tool must not drag npm packages into the repo to do
// what four fetch calls already do.

import { ENV } from './env.mjs';

function headers(prefer = []) {
  const h = {
    apikey: ENV.serviceRoleKey,
    Authorization: `Bearer ${ENV.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
  if (prefer.length > 0) h.Prefer = prefer.join(',');
  return h;
}

function url(table, params = {}) {
  const u = new URL(`${ENV.url}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

async function fail(res, op, table) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 300);
  } catch {
    /* status alone */
  }
  throw new Error(`${op} ${table}: HTTP ${res.status} ${body}`);
}

export async function select(table, params = {}) {
  const res = await fetch(url(table, params), { headers: headers() });
  if (!res.ok) return fail(res, 'select', table);
  return res.json();
}

export async function insert(table, rows, { returning = true, onConflict } = {}) {
  const params = onConflict ? { on_conflict: onConflict } : {};
  const prefer = [returning ? 'return=representation' : 'return=minimal'];
  const res = await fetch(url(table, params), {
    method: 'POST',
    headers: headers(prefer),
    body: JSON.stringify(rows),
  });
  if (!res.ok) return fail(res, 'insert', table);
  return returning ? res.json() : [];
}

/**
 * DELETE, returning the number of rows actually removed.
 *
 * `count=exact` rather than `return=representation`: PostgREST caps a
 * representation, so a 50,000-row delete came back reporting 0 and the
 * teardown log lied about what it had done. The count header does not lie.
 */
export async function remove(table, filters) {
  const res = await fetch(url(table, filters), {
    method: 'DELETE',
    headers: headers(['return=minimal', 'count=exact']),
  });
  if (!res.ok) return fail(res, 'delete', table);
  await res.body?.cancel();
  const range = res.headers.get('content-range') ?? '*/0';
  const total = range.split('/')[1];
  return total === '*' ? 0 : Number(total);
}

/**
 * DELETE in bounded passes until nothing is left.
 *
 * A single `delete from readings where org_id = …` over 200,000 rows is one
 * statement, and it hit the statement timeout mid-teardown — leaving the
 * synthetic rows in place with the harness reporting success. Chunking keeps
 * each statement short.
 *
 * `filters` MUST scope the delete on its own. The chunking is a limit on top
 * of that scope, never the scope itself.
 */
export async function removeChunked(table, filters, { chunk = 5000, maxPasses = 500 } = {}) {
  let removed = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    // PostgREST needs an order to apply a limit to a mutation.
    const n = await remove(table, { ...filters, limit: String(chunk), order: 'org_id' });
    removed += n;
    if (n === 0) return removed;
  }
  throw new Error(
    `removeChunked(${table}) hit ${maxPasses} passes and rows remain. ` +
      'Delete the rest by hand and check the filter.',
  );
}

/** Exact row count, head request — cheap even on the partitioned tables. */
export async function count(table, filters = {}) {
  const res = await fetch(url(table, { ...filters, select: '*' }), {
    method: 'HEAD',
    headers: { ...headers(['count=exact']), Range: '0-0' },
  });
  if (!res.ok) return fail(res, 'count', table);
  const range = res.headers.get('content-range') ?? '*/0';
  const total = range.split('/')[1];
  return total === '*' ? 0 : Number(total);
}
