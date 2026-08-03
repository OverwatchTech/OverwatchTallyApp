/**
 * RLS attack suite — Phase 1.
 *
 * This is not a happy-path test. It signs in as a real member of org A and
 * tries, table by table, to read, change, delete and plant rows in org B. The
 * only acceptable outcome is that every attack fails: zero rows read, zero
 * rows changed, zero rows deleted, and INSERT rejected with Postgres 42501
 * (insufficient privilege — the RLS WITH CHECK).
 *
 * It then walks the role ladder inside org A: crew may log a feeding and
 * acknowledge an alert but may not write schedules, map features or groups;
 * a viewer may read and nothing else; a manager may run operations but not
 * billing; nobody without a platform_role may see the staff plumbing.
 *
 * Run it against a scratch Supabase project, never production:
 *   SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     pnpm --filter @overwatch/db test:rls
 *
 * Without those variables every case below is SKIPPED, and env.ts prints a
 * banner saying so. A skipped run proves nothing — do not read it as green.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MISSING_ENV, RLS_ENV, announceEnv } from './env';
import {
  MEMBER_ROLES,
  STAFF_ONLY_TABLES,
  TENANT_TABLES,
  type AttackContext,
  type MemberRole,
  type TenantTable,
} from './tables';
import {
  auditPartitions,
  extraOnPartition,
  missingFromPartition,
  probePartitionAsMember,
  type PartitionAudit,
} from './partitions';
import {
  decodeJwtClaims,
  serviceClient,
  setupWorld,
  teardownWorld,
  type ActorKey,
  type World,
} from './fixtures';

announceEnv();

const RLS_DENIED = '42501';
const NET = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Partition discovery — done once, at module load, before any test is
// collected, so `describe.each` can fan out over whatever the catalog actually
// holds today. No list, no pull request, no month that nobody remembered.
// ─────────────────────────────────────────────────────────────────────────────

let discovered: PartitionAudit[] = [];
let discoveryError: string | null = null;

if (RLS_ENV.ready) {
  try {
    discovered = await auditPartitions(serviceClient());
  } catch (err) {
    discoveryError = err instanceof Error ? err.message : String(err);
  }
}

/** `readings_202608` for the month we are running in. */
const currentMonthSuffix = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Static checks — these need no database, so `pnpm test` always exercises them.
// ─────────────────────────────────────────────────────────────────────────────

describe('table inventory (no database required)', () => {
  it('names every table exactly once', () => {
    const names = [...TENANT_TABLES.map((t) => t.table), ...STAFF_ONLY_TABLES.map((t) => t.table)];
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes a complete attack for every tenant table', () => {
    const ctx: AttackContext = {
      runId: 'inventorycheck',
      attackerUserId: '00000000-0000-0000-0000-000000000000',
    };
    const victim = {
      orgId: '11111111-1111-1111-1111-111111111111',
      farmId: '22222222-2222-2222-2222-222222222222',
      penFeatureId: '33333333-3333-3333-3333-333333333333',
      gateFeatureId: '44444444-4444-4444-4444-444444444444',
      groupId: '55555555-5555-5555-5555-555555555555',
      feedInventoryId: '66666666-6666-6666-6666-666666666666',
      baleTypeId: '77777777-7777-7777-7777-777777777777',
      deviceId: '88888888-8888-8888-8888-888888888888',
      spareDeviceId: '99999999-9999-9999-9999-999999999999',
      trackerId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    };
    for (const t of TENANT_TABLES) {
      const row = t.crossTenantRow(victim, ctx);
      expect(Object.keys(row).length, `${t.table}: empty attack payload`).toBeGreaterThan(0);
      expect(Object.keys(t.patch).length, `${t.table}: empty update patch`).toBeGreaterThan(0);
      // The payload must actually aim at the victim, or the probe proves nothing.
      const aimed = t.tenantColumn === 'id' || row['org_id'] === victim.orgId;
      expect(aimed, `${t.table}: attack payload does not target the victim org`).toBe(true);
      for (const role of [
        ...t.memberRead,
        ...t.memberInsert,
        ...t.memberUpdate,
        ...t.memberDelete,
      ]) {
        expect(MEMBER_ROLES, `${t.table}: unknown role ${role}`).toContain(role);
      }
    }
  });

  it('keeps write privilege inside read privilege', () => {
    for (const t of TENANT_TABLES) {
      for (const role of [...t.memberInsert, ...t.memberUpdate, ...t.memberDelete]) {
        expect(t.memberRead, `${t.table}: ${role} may write but not read`).toContain(role);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Partition row security — the catalog invariant.
//
// This block is why the suite exists in its current form. On 2026-08-03 the
// 138 cases above were green while `readings_2026_08` was readable by any
// authenticated user in any org: Postgres applies a partitioned table's RLS
// only to queries routed THROUGH the parent, and `tables.ts` names parents.
// 1,050 rows of another tenant's telemetry were reachable. Migration 0009
// fixed the data; these cases are the fix to the TEST.
//
// The invariant, asserted directly rather than inferred from a probe:
//   every partition of an RLS-enabled parent has relrowsecurity = true,
//   and carries a policy set equivalent to its parent's.
//
// It needs no fixture world — only the catalog — so it runs even if the
// tenant fixtures fail to build.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!RLS_ENV.ready)('partition row security (catalog invariant)', () => {
  it('discovers partitions from pg_class / pg_inherits', () => {
    expect(discoveryError, `partition discovery failed:\n${discoveryError}`).toBeNull();
    expect(
      discovered.length,
      'the catalog reports zero partitions. Either pg_cron stopped creating ' +
        'them (readings/raw_events/tracker_positions are partitioned by month ' +
        'in 0003) or the audit function is filtering everything out. Both are ' +
        'failures: an unpartitioned readings table would silently pass every ' +
        'case below.',
    ).toBeGreaterThan(0);
  });

  it('covers the month we are running in', () => {
    // pg_cron runs app.ensure_month_partitions 3 months ahead (0009). If the
    // current month is missing, ingest is writing into a partition that was
    // created ad hoc — or failing outright — and nothing else here would say so.
    const suffix = currentMonthSuffix();
    const parents = [...new Set(discovered.map((p) => p.parent_name))];
    expect(parents.length, 'no partitioned parents discovered').toBeGreaterThan(0);
    for (const parent of parents) {
      const want = `${parent}_${suffix}`;
      expect(
        discovered.map((p) => p.partition_name),
        `${want} does not exist — app.ensure_month_partitions has not run for this month`,
      ).toContain(want);
    }
  });

  describe.each(discovered)('$partition_name', (row: PartitionAudit) => {
    it('has row security enabled when its parent does', () => {
      if (!row.parent_rls) return; // nothing to mirror
      expect(
        row.partition_rls,
        `LEAK — ${row.partition_name} has relrowsecurity = false while its parent ` +
          `${row.parent_name} has it on. Every authenticated user can read this ` +
          `partition directly, in every org. Fix: select app.secure_time_partition(` +
          `'${row.partition_name}', '${row.parent_name}');`,
      ).toBe(true);
    });

    it("carries its parent's policies", () => {
      if (!row.parent_rls) return;
      const missing = missingFromPartition(row);
      expect(
        missing,
        `${row.partition_name} is missing ${missing.length} of ${row.parent_name}'s ` +
          `policies. RLS with no policy that admits a row denies everything, but a ` +
          `PARTIAL mirror is worse than either: it admits some rows to some roles ` +
          `on rules nobody wrote down. Missing:\n  ${missing.join('\n  ')}`,
      ).toEqual([]);
    });

    it('carries no policy its parent does not', () => {
      if (!row.parent_rls) return;
      const extra = extraOnPartition(row);
      expect(
        extra,
        `${row.partition_name} has ${extra.length} policies its parent does not. ` +
          `A partition is not a place to widen access — whoever needs this should ` +
          `write it on ${row.parent_name} where it is reviewable. Extra:\n  ${extra.join('\n  ')}`,
      ).toEqual([]);
    });

    it('matches its parent on FORCE ROW LEVEL SECURITY', () => {
      expect(
        row.partition_forced,
        `${row.partition_name} and ${row.parent_name} disagree on force row level ` +
          `security; the table owner is exempt on one and not the other.`,
      ).toBe(row.parent_forced);
    });
  });

  it('publishes every partition of a realtime-published family, or none', () => {
    // Supabase Realtime authorizes postgres_changes against the relation the
    // WAL row came from, and the publication is per-partition (pubviaroot off).
    // A month whose partition never made it into supabase_realtime is a month
    // where the dashboard silently stops updating — or, if RLS were also
    // missing, a farm-wide broadcast. 0009 keeps them in step; this asserts it.
    const byParent = new Map<string, PartitionAudit[]>();
    for (const row of discovered) {
      const list = byParent.get(row.parent_name) ?? [];
      list.push(row);
      byParent.set(row.parent_name, list);
    }
    for (const [parent, rows] of byParent) {
      const published = rows.filter((r) => r.in_realtime_publication).map((r) => r.partition_name);
      const absent = rows.filter((r) => !r.in_realtime_publication).map((r) => r.partition_name);
      if (published.length === 0) continue; // family is not on the rail at all
      expect(
        absent,
        `${parent} is published to supabase_realtime for ${published.length} of its ` +
          `${rows.length} partitions. Realtime subscribers will miss every row that ` +
          `lands in: ${absent.join(', ')}. Fix: select app.publish_readings_partition(...).`,
      ).toEqual([]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live suite. SKIPPED (never passed) when credentials are absent.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!RLS_ENV.ready)(
  `RLS attack suite${RLS_ENV.ready ? '' : ` — SKIPPED, missing ${MISSING_ENV.join(', ')}`}`,
  () => {
    let world: World;

    beforeAll(async () => {
      world = await setupWorld();
    }, 180_000);

    afterAll(async () => {
      if (world) await teardownWorld(world);
    }, 180_000);

    const attacker = () => world.actors.ownerA.client;
    const ctx = (): AttackContext => ({
      runId: world.runId,
      attackerUserId: world.actors.ownerA.userId,
    });

    /** Exactly what the service role can see for one org — the ground truth. */
    async function snapshot(table: string, column: string, id: string): Promise<string[]> {
      const { data, error } = await world.service.from(table).select('*').eq(column, id);
      if (error) throw new Error(`snapshot(${table}) failed: ${error.message}`);
      return ((data ?? []) as Record<string, unknown>[]).map((r) => JSON.stringify(r)).sort();
    }

    async function countRows(table: string, column: string, id: string): Promise<number> {
      const { count, error } = await world.service
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(column, id);
      if (error) throw new Error(`count(${table}) failed: ${error.message}`);
      return count ?? 0;
    }

    // ── the auth hook ───────────────────────────────────────────────────────
    const CLAIM_CASES: readonly [ActorKey, MemberRole][] = [
      ['ownerA', 'owner'],
      ['managerA', 'manager'],
      ['crewA', 'crew'],
      ['viewerA', 'viewer'],
      ['ownerB', 'owner'],
    ];

    describe('JWT custom claims', () => {
      it.each(CLAIM_CASES)('%s carries org_id and member_role', (key, role) => {
        const actor = world.actors[key];
        const claims = decodeJwtClaims(actor.accessToken);
        const hookHint =
          'the access-token hook is not stamping claims. Enable it: Supabase dashboard → ' +
          'Auth → Hooks → Customize Access Token → public.custom_access_token ' +
          '(migrations/0005_auth_claims_hook.sql). Until it is on, every policy in ' +
          'the schema evaluates against a null org_id and the whole app is locked out.';

        expect(claims['org_id'], `${actor.email}: no org_id claim — ${hookHint}`).toBeDefined();
        expect(
          claims['member_role'],
          `${actor.email}: no member_role claim — ${hookHint}`,
        ).toBeDefined();
        expect(claims['org_id']).toBe(actor.orgKey === 'A' ? world.orgA.orgId : world.orgB.orgId);
        expect(claims['member_role']).toBe(role);
        // A customer must never be handed staff powers by accident.
        expect(claims['platform_role']).toBeUndefined();
      });
    });

    // ── the matrix: org A owner vs every tenant table of org B ──────────────
    describe.each(TENANT_TABLES as TenantTable[])('$table (cross-tenant)', (t) => {
      const col = t.tenantColumn;

      it(
        'SELECT returns org A rows and zero org B rows',
        async () => {
          const own = await attacker().from(t.table).select(col).eq(col, world.orgA.orgId);
          expect(own.error, `${t.table}: own-org SELECT errored`).toBeNull();
          expect(
            own.data?.length ?? 0,
            `${t.table}: owner A cannot see their own rows — fixture or read policy is broken`,
          ).toBeGreaterThan(0);

          // The victim really does have rows; the empty result below is RLS.
          expect(await countRows(t.table, col, world.orgB.orgId)).toBeGreaterThan(0);

          const foreign = await attacker().from(t.table).select('*').eq(col, world.orgB.orgId);
          expect(foreign.error, `${t.table}: cross-tenant SELECT errored`).toBeNull();
          expect(
            foreign.data ?? [],
            `${t.table}: LEAK — org A read ${foreign.data?.length ?? 0} org B rows`,
          ).toEqual([]);
        },
        NET,
      );

      it(
        'UPDATE against org B changes nothing',
        async () => {
          const before = await snapshot(t.table, col, world.orgB.orgId);
          expect(before.length).toBeGreaterThan(0);

          const res = await attacker()
            .from(t.table)
            .update(t.patch)
            .eq(col, world.orgB.orgId)
            .select();
          if (res.error) {
            // Some tables reject outright rather than matching zero rows; both
            // are fine, anything else is not.
            expect(res.error.code, `${t.table}: unexpected UPDATE error`).toBe(RLS_DENIED);
          }
          expect(res.data ?? [], `${t.table}: org A updated org B rows`).toEqual([]);
          expect(
            await snapshot(t.table, col, world.orgB.orgId),
            `${t.table}: org B data changed under a cross-tenant UPDATE`,
          ).toEqual(before);
        },
        NET,
      );

      it(
        'DELETE against org B removes nothing',
        async () => {
          const before = await snapshot(t.table, col, world.orgB.orgId);
          expect(before.length).toBeGreaterThan(0);

          const res = await attacker().from(t.table).delete().eq(col, world.orgB.orgId).select();
          if (res.error) {
            expect(res.error.code, `${t.table}: unexpected DELETE error`).toBe(RLS_DENIED);
          }
          expect(res.data ?? [], `${t.table}: org A deleted org B rows`).toEqual([]);
          expect(
            await snapshot(t.table, col, world.orgB.orgId),
            `${t.table}: org B data changed under a cross-tenant DELETE`,
          ).toEqual(before);
        },
        NET,
      );

      it(
        'INSERT into org B is rejected with 42501',
        async () => {
          const before = await countRows(t.table, col, world.orgB.orgId);
          const payload = t.crossTenantRow(world.orgB, ctx());

          // No .select() — a representation request could fail on the SELECT
          // policy instead, and the WITH CHECK is what we are testing.
          const { error } = await attacker().from(t.table).insert(payload);

          expect(error, `${t.table}: cross-tenant INSERT was NOT rejected`).not.toBeNull();
          expect(
            error?.code,
            `${t.table}: rejected with ${error?.code} "${error?.message}" — expected RLS ${RLS_DENIED}`,
          ).toBe(RLS_DENIED);
          expect(await countRows(t.table, col, world.orgB.orgId)).toBe(before);
        },
        NET,
      );
    });

    // ── partitions, addressed directly ──────────────────────────────────────
    // The catalog block above proves the policies are there. This proves the
    // consequence: GET /rest/v1/readings_202608 — the literal request that
    // returned 1,050 foreign rows on 2026-08-03 — comes back with nothing.
    describe('partitions addressed by name (the original attack)', () => {
      it(
        'org B really does have rows in this month, so the probes are not vacuous',
        async () => {
          // Written through the PARENT by the fixture; they land in the
          // current-month partition. If this is zero, every probe below would
          // pass by having nothing to find.
          for (const parent of ['readings', 'raw_events', 'tracker_positions']) {
            expect(
              await countRows(parent, 'org_id', world.orgB.orgId),
              `${parent}: fixture seeded no org B row`,
            ).toBeGreaterThan(0);
          }
        },
        NET,
      );

      it.each(discovered.map((p) => [p.partition_name] as const))(
        '%s: org A owner reads zero org B rows',
        async (partition) => {
          const verdict = await probePartitionAsMember(
            RLS_ENV.url,
            RLS_ENV.anonKey,
            world.actors.ownerA.accessToken,
            partition,
            'org_id',
            world.orgB.orgId,
          );
          if (verdict.kind === 'error') {
            throw new Error(
              `${partition}: unexpected HTTP ${verdict.status} — ${verdict.body}`,
            );
          }
          if (verdict.kind === 'not_exposed') {
            // Acceptable, and worth saying out loud: this project's PostgREST
            // does not carry partitions in its schema cache today, so the API
            // layer refuses the request before RLS is consulted. That is a
            // configuration of someone else's software, not a boundary we own
            // — Realtime and any direct SQL path still reach the partition,
            // which is why the catalog invariant above is the real guard.
            return;
          }
          expect(
            verdict.count,
            `LEAK — org A read ${verdict.count} org B rows straight out of ` +
              `${partition}, bypassing the parent's RLS entirely.`,
          ).toBe(0);
        },
        NET,
      );
    });

    // ── staff-only surfaces ─────────────────────────────────────────────────
    describe('staff-only tables are invisible to members', () => {
      it.each(STAFF_ONLY_TABLES.map((s) => [s.table, s.tenantColumn] as const))(
        '%s: org A owner reads zero rows',
        async (table, column) => {
          const id = column === 'org_id' ? world.orgA.orgId : world.orgA.farmId;
          expect(
            await countRows(table, column, id),
            `${table}: fixture missing, the probe would be vacuous`,
          ).toBeGreaterThan(0);

          const res = await attacker().from(table).select('*').eq(column, id);
          expect(res.error, `${table}: SELECT errored`).toBeNull();
          expect(
            res.data ?? [],
            `${table}: LEAK — a member without platform_role read staff-only rows`,
          ).toEqual([]);
        },
        NET,
      );

      it(
        'a member cannot provision a device in their own org',
        async () => {
          const { error } = await attacker()
            .from('devices')
            .insert({
              org_id: world.orgA.orgId,
              farm_id: world.orgA.farmId,
              dev_eui: `${world.runId}SELFSERVE`.toUpperCase(),
              model: 'EM400-UDL',
              role: 'trough_level',
            });
          expect(error?.code, 'a customer provisioned a device (CLAUDE.md #12)').toBe(RLS_DENIED);
        },
        NET,
      );

      it(
        'a member cannot register a gateway in their own org',
        async () => {
          const { error } = await attacker()
            .from('gateways')
            .insert({
              org_id: world.orgA.orgId,
              farm_id: world.orgA.farmId,
              gateway_sn: `${world.runId}-SELFSERVE`,
              model: 'UG65',
            });
          expect(error?.code, 'a customer registered a gateway').toBe(RLS_DENIED);
        },
        NET,
      );

      it(
        'a member cannot write the audit log',
        async () => {
          const { error } = await attacker()
            .from('audit_log')
            .insert({ org_id: world.orgA.orgId, action: 'forged.entry' });
          expect(error?.code, 'a member forged an audit_log entry').toBe(RLS_DENIED);
        },
        NET,
      );
    });

    // ── the role ladder inside org A ────────────────────────────────────────
    describe('role ladder within org A', () => {
      const as = (key: 'ownerA' | 'managerA' | 'crewA' | 'viewerA') => world.actors[key].client;

      it(
        'crew CAN log a feed event',
        async () => {
          const { data, error } = await as('crewA')
            .from('feed_events')
            .insert({
              org_id: world.orgA.orgId,
              farm_id: world.orgA.farmId,
              pen_feature_id: world.orgA.penFeatureId,
              group_id: world.orgA.groupId,
              amount_kg: 425,
              source: 'crew_logged',
            })
            .select()
            .single();
          expect(error, `crew could not log a feeding: ${error?.message}`).toBeNull();
          expect(data?.['source']).toBe('crew_logged');
        },
        NET,
      );

      it(
        'crew CAN acknowledge an alert',
        async () => {
          const open = await as('crewA').from('alerts').select('id').eq('org_id', world.orgA.orgId);
          expect(open.error).toBeNull();
          const alertId = String((open.data ?? [])[0]?.['id']);
          expect(alertId, 'no alert fixture to acknowledge').not.toBe('undefined');

          const { data, error } = await as('crewA')
            .from('alerts')
            .update({
              acknowledged_at: new Date().toISOString(),
              acknowledged_by: world.actors.crewA.userId,
            })
            .eq('id', alertId)
            .select();
          expect(error, `crew could not acknowledge an alert: ${error?.message}`).toBeNull();
          expect(data?.length ?? 0).toBe(1);
        },
        NET,
      );

      const CREW_DENIED: readonly [string, () => Record<string, unknown>][] = [
        [
          'feed_schedules',
          () => ({
            org_id: world.orgA.orgId,
            farm_id: world.orgA.farmId,
            pen_feature_id: world.orgA.penFeatureId,
            target_kg: 10,
          }),
        ],
        [
          'map_features',
          () => ({
            org_id: world.orgA.orgId,
            farm_id: world.orgA.farmId,
            kind: 'pen',
            name: `${world.runId} crew pen`,
            geom: 'SRID=4326;POINT(-104.9 40.5)',
          }),
        ],
        [
          'groups',
          () => ({
            org_id: world.orgA.orgId,
            farm_id: world.orgA.farmId,
            name: `${world.runId} crew group`,
          }),
        ],
      ];

      it.each(CREW_DENIED)(
        'crew CANNOT insert %s',
        async (table, build) => {
          const { error } = await as('crewA').from(table).insert(build());
          expect(error?.code, `crew wrote ${table} (manager+ only)`).toBe(RLS_DENIED);
        },
        NET,
      );

      it(
        'viewer CAN read farms',
        async () => {
          const { data, error } = await as('viewerA').from('farms').select('id,name');
          expect(error).toBeNull();
          expect(data?.length ?? 0).toBeGreaterThan(0);
        },
        NET,
      );

      it(
        'viewer CANNOT log a feed event',
        async () => {
          const { error } = await as('viewerA').from('feed_events').insert({
            org_id: world.orgA.orgId,
            farm_id: world.orgA.farmId,
            amount_kg: 1,
            source: 'crew_logged',
          });
          expect(error?.code, 'a viewer wrote a feed event').toBe(RLS_DENIED);
        },
        NET,
      );

      it(
        'viewer CANNOT update a farm',
        async () => {
          const before = await snapshot('farms', 'org_id', world.orgA.orgId);
          const { data, error } = await as('viewerA')
            .from('farms')
            .update({ name: 'viewer was here' })
            .eq('org_id', world.orgA.orgId)
            .select();
          if (error) expect(error.code).toBe(RLS_DENIED);
          expect(data ?? [], 'a viewer renamed a farm').toEqual([]);
          expect(await snapshot('farms', 'org_id', world.orgA.orgId)).toEqual(before);
        },
        NET,
      );

      it(
        'manager CAN create a feed schedule',
        async () => {
          const { data, error } = await as('managerA')
            .from('feed_schedules')
            .insert({
              org_id: world.orgA.orgId,
              farm_id: world.orgA.farmId,
              group_id: world.orgA.groupId,
              target_kg: 880,
            })
            .select()
            .single();
          expect(error, `manager could not create a schedule: ${error?.message}`).toBeNull();
          expect(data?.['active']).toBe(true);
        },
        NET,
      );

      it(
        'manager CANNOT update the org (owner-only)',
        async () => {
          const before = await snapshot('orgs', 'id', world.orgA.orgId);
          const { data, error } = await as('managerA')
            .from('orgs')
            .update({ billing_email: 'manager@test.local' })
            .eq('id', world.orgA.orgId)
            .select();
          if (error) expect(error.code).toBe(RLS_DENIED);
          expect(data ?? [], 'a manager edited billing').toEqual([]);
          expect(
            await snapshot('orgs', 'id', world.orgA.orgId),
            'org row changed under a manager UPDATE',
          ).toEqual(before);
        },
        NET,
      );

      it(
        'owner CAN update the org (positive control)',
        async () => {
          const { data, error } = await as('ownerA')
            .from('orgs')
            .update({ billing_contact_name: 'Owner A' })
            .eq('id', world.orgA.orgId)
            .select();
          expect(error, `owner could not update their org: ${error?.message}`).toBeNull();
          expect(data?.length ?? 0).toBe(1);
        },
        NET,
      );

      it(
        'nobody may delete a feed event (no member DELETE policy exists)',
        async () => {
          const before = await snapshot('feed_events', 'org_id', world.orgA.orgId);
          expect(before.length).toBeGreaterThan(0);
          const { data, error } = await as('ownerA')
            .from('feed_events')
            .delete()
            .eq('org_id', world.orgA.orgId)
            .select();
          if (error) expect(error.code).toBe(RLS_DENIED);
          expect(data ?? [], 'a member deleted feed history').toEqual([]);
          expect(await snapshot('feed_events', 'org_id', world.orgA.orgId)).toEqual(before);
        },
        NET,
      );

      it(
        'owner of org B is equally locked out of org A',
        async () => {
          const client = world.actors.ownerB.client;
          const read = await client.from('farms').select('id').eq('org_id', world.orgA.orgId);
          expect(read.error).toBeNull();
          expect(read.data ?? [], 'org B read org A farms — isolation is not symmetric').toEqual(
            [],
          );

          const { error } = await client.from('feed_events').insert({
            org_id: world.orgA.orgId,
            farm_id: world.orgA.farmId,
            amount_kg: 1,
            source: 'crew_logged',
          });
          expect(error?.code, 'org B planted a feed event in org A').toBe(RLS_DENIED);
        },
        NET,
      );
    });
  },
);
