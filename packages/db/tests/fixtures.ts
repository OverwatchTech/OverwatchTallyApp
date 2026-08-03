/**
 * Fixture world for the RLS attack suite: two tenants that should never be
 * able to see each other.
 *
 *   org A ── owner-a, manager-a, crew-a, viewer-a   (the attacker's tenant)
 *   org B ── owner-b                                (the victim)
 *
 * Every row and every user is created with the service role (which bypasses
 * RLS) and carries a unique run prefix, so two runs — local and CI, or two CI
 * shards — never collide and teardown never touches anything it did not make.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { RLS_ENV } from './env';
import { NON_CASCADING_TABLES, type FixtureIds, type MemberRole } from './tables';

// Node ≥18 provides atob; packages/db carries no @types/node (see env.ts).
declare function atob(data: string): string;

type Row = Record<string, unknown>;
// The suite drives tables by name, so the clients stay unparameterised: the
// generated `Database` type would make `.from(someString)` untypeable.
type Client = SupabaseClient;

export type ActorKey = 'ownerA' | 'managerA' | 'crewA' | 'viewerA' | 'ownerB';

export interface TestActor {
  readonly key: ActorKey;
  readonly email: string;
  readonly userId: string;
  readonly orgKey: 'A' | 'B';
  readonly role: MemberRole;
  readonly accessToken: string;
  readonly client: Client;
}

export type PlatformRole = 'installer' | 'support' | 'admin';

/**
 * A Mac's Tech staff account — the sixth actor, and the one whose absence let
 * a total cross-tenant read leak sit under 207 green cases. It deliberately has
 * NO org_members row: staff are not customers, so every row it can reach
 * arrives through a staff policy and nothing else. If it were a member of org
 * A, org A's rows would come back through the member policies and the staff
 * probes below would prove nothing.
 */
export interface StaffTestActor {
  readonly email: string;
  readonly userId: string;
  readonly platformRole: PlatformRole;
  readonly accessToken: string;
  readonly client: Client;
}

export interface World {
  readonly runId: string;
  readonly service: Client;
  readonly orgA: FixtureIds;
  readonly orgB: FixtureIds;
  readonly actors: Readonly<Record<ActorKey, TestActor>>;
  readonly staff: StaffTestActor;
}

const POINT = 'SRID=4326;POINT(-104.912 40.501)';
const PEN_POLYGON =
  'SRID=4326;POLYGON((-104.912 40.501,-104.902 40.501,-104.902 40.511,-104.912 40.511,-104.912 40.501))';

const nowIso = (): string => new Date().toISOString();

function hourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

function lastHourRange(): string {
  const end = new Date();
  const start = new Date(end.getTime() - 3_600_000);
  return `["${start.toISOString()}","${end.toISOString()}")`;
}

/** Lowercase alphanumeric, safe in emails, labels and DevEUIs. */
export function newRunId(): string {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function serviceClient(): Client {
  return createClient(RLS_ENV.url, RLS_ENV.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Decodes a JWT payload. Signature is Supabase's business, claims are ours. */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (payload === undefined) throw new Error('access token is not a JWT (no payload segment)');
  const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function insertOne(service: Client, table: string, row: Row): Promise<Row> {
  const { data, error } = await service.from(table).insert(row).select().single();
  if (error) {
    throw new Error(
      `fixture insert into ${table} failed: ${error.message} [${error.code ?? 'no code'}]` +
        (error.details ? ` — ${error.details}` : ''),
    );
  }
  return data as Row;
}

const idOf = (row: Row): string => String(row['id']);

/** Seeds one complete tenant: every table in the inventory gets a row. */
async function seedOrg(service: Client, runId: string, key: 'A' | 'B'): Promise<FixtureIds> {
  const tag = `${runId}-${key}`;

  const org = await insertOne(service, 'orgs', {
    name: `RLS suite ${tag}`,
    billing_email: `${tag}-billing@test.local`,
  });
  const orgId = idOf(org);

  const farm = await insertOne(service, 'farms', {
    org_id: orgId,
    name: `${tag} home place`,
    centroid: POINT,
  });
  const farmId = idOf(farm);

  const pen = await insertOne(service, 'map_features', {
    org_id: orgId,
    farm_id: farmId,
    kind: 'pen',
    name: `${tag} North Lot`,
    geom: PEN_POLYGON,
    capacity_head: 120,
    source: 'kml_import',
  });
  const penFeatureId = idOf(pen);

  const gate = await insertOne(service, 'map_features', {
    org_id: orgId,
    farm_id: farmId,
    kind: 'gate',
    name: `${tag} North Gate`,
    geom: POINT,
    source: 'kml_import',
  });
  const gateFeatureId = idOf(gate);

  await insertOne(service, 'feature_links', {
    org_id: orgId,
    farm_id: farmId,
    from_feature_id: penFeatureId,
    to_feature_id: gateFeatureId,
    relation: 'connects',
  });

  const group = await insertOne(service, 'groups', {
    org_id: orgId,
    farm_id: farmId,
    name: `${tag} yearlings`,
    species: 'cattle',
    avg_weight_kg: 340,
  });
  const groupId = idOf(group);

  await insertOne(service, 'group_placements', {
    org_id: orgId,
    farm_id: farmId,
    group_id: groupId,
    pen_feature_id: penFeatureId,
  });

  await insertOne(service, 'head_count_events', {
    org_id: orgId,
    farm_id: farmId,
    group_id: groupId,
    delta: 84,
    reason: 'arrival',
  });

  const baleType = await insertOne(service, 'bale_types', {
    org_id: orgId,
    farm_id: farmId,
    label: `${tag} 4x5 round`,
    shape: 'round',
    dim_a_m: 1.2192,
    dim_b_m: 1.524,
    nominal_weight_kg: 385.6,
  });
  const baleTypeId = idOf(baleType);

  const inventory = await insertOne(service, 'feed_inventory', {
    org_id: orgId,
    farm_id: farmId,
    map_feature_id: penFeatureId,
    feed_type: 'alfalfa',
    bale_type_id: baleTypeId,
    count_source: 'hand_counted',
  });
  const feedInventoryId = idOf(inventory);

  await insertOne(service, 'bale_movements', {
    org_id: orgId,
    farm_id: farmId,
    feed_inventory_id: feedInventoryId,
    delta: 60,
    reason: 'delivered',
  });

  await insertOne(service, 'farm_bale_calibrations', {
    org_id: orgId,
    farm_id: farmId,
    bale_type_id: baleTypeId,
    measured_weight_kg: 391.4,
  });

  await insertOne(service, 'feed_schedules', {
    org_id: orgId,
    farm_id: farmId,
    pen_feature_id: penFeatureId,
    target_kg: 950,
  });

  await insertOne(service, 'feed_events', {
    org_id: orgId,
    farm_id: farmId,
    pen_feature_id: penFeatureId,
    group_id: groupId,
    amount_kg: 940,
    source: 'crew_logged',
  });

  const device = await insertOne(service, 'devices', {
    org_id: orgId,
    farm_id: farmId,
    dev_eui: `${runId}${key}01`.toUpperCase(),
    model: 'EM400-UDL',
    role: 'trough_level',
    mounted_on: penFeatureId,
    status: 'live',
  });
  const deviceId = idOf(device);

  const spareDevice = await insertOne(service, 'devices', {
    org_id: orgId,
    farm_id: farmId,
    dev_eui: `${runId}${key}02`.toUpperCase(),
    model: 'EM300-TH',
    role: 'gate_contact',
    status: 'registered',
  });
  const spareDeviceId = idOf(spareDevice);

  await insertOne(service, 'device_calibrations', {
    org_id: orgId,
    device_id: deviceId,
    version: 1,
    curve: { kind: 'linear', points: [[0, 0]] },
  });

  await insertOne(service, 'gateways', {
    org_id: orgId,
    farm_id: farmId,
    gateway_sn: `${tag}-GW`,
    model: 'UG65',
    backhaul: 'cellular',
  });

  await insertOne(service, 'water_events', {
    org_id: orgId,
    farm_id: farmId,
    trough_feature_id: penFeatureId,
    device_id: deviceId,
    interval_range: lastHourRange(),
    volume_l: 430,
    method: 'pulse_count',
  });

  await insertOne(service, 'gate_events', {
    org_id: orgId,
    farm_id: farmId,
    gate_feature_id: gateFeatureId,
    device_id: spareDeviceId,
    state: 'open',
    occurred_at: nowIso(),
    duration_s: 90,
  });

  const rule = await insertOne(service, 'alert_rules', {
    org_id: orgId,
    farm_id: farmId,
    kind: 'trough_low',
    severity: 'warn',
  });

  await insertOne(service, 'alerts', {
    org_id: orgId,
    farm_id: farmId,
    rule_id: idOf(rule),
    kind: 'trough_low',
    severity: 'warn',
    dedup_key: `${tag}-fixture`,
  });

  await insertOne(service, 'subscriptions', {
    org_id: orgId,
    farm_id: farmId,
    status: 'active',
    tier: 'tier_1',
  });

  await insertOne(service, 'hardware_orders', {
    org_id: orgId,
    farm_id: farmId,
    status: 'quote',
    notes: `${tag} fixture`,
  });

  await insertOne(service, 'readings', {
    org_id: orgId,
    farm_id: farmId,
    device_id: deviceId,
    metric: 'distance_mm',
    value: 812,
    received_at: nowIso(),
  });

  await insertOne(service, 'readings_hourly', {
    org_id: orgId,
    farm_id: farmId,
    device_id: deviceId,
    metric: 'distance_mm',
    bucket_start: hourBucketIso(),
    min: 800,
    max: 830,
    avg: 812,
    sum: 4872,
    last: 812,
    sample_count: 6,
  });

  await insertOne(service, 'readings_daily', {
    org_id: orgId,
    farm_id: farmId,
    device_id: deviceId,
    metric: 'distance_mm',
    bucket_start: new Date().toISOString().slice(0, 10),
    min: 780,
    max: 860,
    avg: 815,
    sum: 117360,
    last: 812,
    sample_count: 144,
  });

  await insertOne(service, 'device_health', {
    device_id: deviceId,
    org_id: orgId,
    farm_id: farmId,
    online: true,
    last_seen_at: nowIso(),
    expected_interval_s: 3600,
  });

  const tracker = await insertOne(service, 'trackers', {
    org_id: orgId,
    farm_id: farmId,
    label: `${tag} feed truck`,
    source: 'mdp',
  });
  const trackerId = idOf(tracker);

  await insertOne(service, 'tracker_positions', {
    org_id: orgId,
    farm_id: farmId,
    tracker_id: trackerId,
    recorded_at: nowIso(),
    geom: POINT,
    source: 'mdp',
  });

  // staff-only plumbing — seeded so "member sees nothing" is not vacuous
  await insertOne(service, 'audit_log', {
    org_id: orgId,
    farm_id: farmId,
    action: 'rls_suite.seed',
    table_name: 'orgs',
    record_id: orgId,
    reason: 'fixture',
  });

  await insertOne(service, 'raw_events', {
    org_id: orgId,
    farm_id: farmId,
    mdp_event_id: `${tag}-raw`,
    event_type: 'device.data',
    envelope: { fixture: true, run: runId },
  });

  await insertOne(service, 'dead_letter_events', {
    org_id: orgId,
    farm_id: farmId,
    mdp_event_id: `${tag}-dlq`,
    error: 'fixture row — never processed',
  });

  await insertOne(service, 'ingest_event_ids', {
    mdp_event_id: `${tag}-ingest`,
    farm_id: farmId,
  });

  return {
    orgId,
    farmId,
    penFeatureId,
    gateFeatureId,
    groupId,
    feedInventoryId,
    baleTypeId,
    deviceId,
    spareDeviceId,
    trackerId,
  };
}

interface ActorSpec {
  readonly key: ActorKey;
  readonly local: string;
  readonly orgKey: 'A' | 'B';
  readonly role: MemberRole;
}

const ACTOR_SPECS: readonly ActorSpec[] = [
  { key: 'ownerA', local: 'owner-a', orgKey: 'A', role: 'owner' },
  { key: 'managerA', local: 'manager-a', orgKey: 'A', role: 'manager' },
  { key: 'crewA', local: 'crew-a', orgKey: 'A', role: 'crew' },
  { key: 'viewerA', local: 'viewer-a', orgKey: 'A', role: 'viewer' },
  { key: 'ownerB', local: 'owner-b', orgKey: 'B', role: 'owner' },
];

async function createActor(
  service: Client,
  runId: string,
  spec: ActorSpec,
  orgId: string,
): Promise<TestActor> {
  const email = `${runId}-${spec.local}@test.local`;
  // Ephemeral: generated per run, used only to sign these fixtures in, and the
  // users are deleted in teardown. Never written to disk, never logged.
  const password = `Rls-${runId}-Aa1!`;

  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { rls_suite_run: runId },
  });
  if (created.error || !created.data.user) {
    throw new Error(`could not create ${email}: ${created.error?.message ?? 'no user returned'}`);
  }
  const userId = created.data.user.id;

  const membership = await service
    .from('org_members')
    .insert({ org_id: orgId, user_id: userId, role: spec.role });
  if (membership.error) {
    throw new Error(`could not add ${email} to org: ${membership.error.message}`);
  }

  // Sign in on the anon key exactly as the app would — this is what makes the
  // access-token hook run and stamp org_id / member_role.
  const anon = createClient(RLS_ENV.url, RLS_ENV.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`sign-in failed for ${email}: ${signIn.error?.message ?? 'no session'}`);
  }
  const accessToken = signIn.data.session.access_token;

  const client = createClient(RLS_ENV.url, RLS_ENV.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  return {
    key: spec.key,
    email,
    userId,
    orgKey: spec.orgKey,
    role: spec.role,
    accessToken,
    client,
  };
}

/**
 * The staff actor. `platform_role` goes in app_metadata, which is writable only
 * through the admin API — a user cannot set it on themselves — and 0005's
 * access-token hook copies it into the JWT, where app.is_staff() reads it.
 */
async function createStaffActor(
  service: Client,
  runId: string,
  platformRole: PlatformRole,
): Promise<StaffTestActor> {
  const email = `${runId}-staff@test.local`;
  const password = `Rls-${runId}-Aa1!`;

  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { rls_suite_run: runId },
    app_metadata: { platform_role: platformRole },
  });
  if (created.error || !created.data.user) {
    throw new Error(
      `could not create staff ${email}: ${created.error?.message ?? 'no user returned'}`,
    );
  }

  // No org_members insert. That omission is the point — see StaffTestActor.

  const anon = createClient(RLS_ENV.url, RLS_ENV.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session) {
    throw new Error(`staff sign-in failed for ${email}: ${signIn.error?.message ?? 'no session'}`);
  }
  const accessToken = signIn.data.session.access_token;

  return {
    email,
    userId: created.data.user.id,
    platformRole,
    accessToken,
    client: createClient(RLS_ENV.url, RLS_ENV.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  };
}

export interface Grant {
  readonly auditId: number;
  readonly orgId: string;
}

/**
 * Open a support session on one org, the way lib/admin/impersonation.ts does:
 * an `impersonation.start` row in audit_log carrying org, reason and an expiry
 * inside 60 minutes. Written with the SERVICE role so the fixture does not
 * depend on the console's own code path being correct.
 *
 * The staff client's existing access token is NOT reissued and does not need to
 * be — app.staff_scope_org() reads the grant out of audit_log on every query,
 * so the scope is server-side state, never a claim the client could forge.
 */
export async function startGrant(
  world: World,
  orgId: string,
  reason = 'rls suite staff scope probe',
  minutes = 30,
): Promise<Grant> {
  const { data, error } = await world.service
    .from('audit_log')
    .insert({
      actor_user_id: world.staff.userId,
      actor_platform_role: world.staff.platformRole,
      org_id: orgId,
      table_name: 'orgs',
      record_id: orgId,
      action: 'impersonation.start',
      reason,
      impersonation_expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`could not open grant: ${error?.message ?? 'no row'}`);
  return { auditId: (data as { id: number }).id, orgId };
}

/** Close it. audit_log is append-only, so ending is a second row, never a delete. */
export async function endGrant(world: World, grant: Grant): Promise<void> {
  const { error } = await world.service.from('audit_log').insert({
    actor_user_id: world.staff.userId,
    actor_platform_role: world.staff.platformRole,
    org_id: grant.orgId,
    table_name: 'orgs',
    record_id: String(grant.auditId),
    action: 'impersonation.end',
    reason: 'rls suite staff scope probe',
  });
  if (error) throw new Error(`could not close grant: ${error.message}`);
}

export async function setupWorld(): Promise<World> {
  const runId = newRunId();
  const service = serviceClient();

  const orgA = await seedOrg(service, runId, 'A');
  const orgB = await seedOrg(service, runId, 'B');

  const actors: Partial<Record<ActorKey, TestActor>> = {};
  for (const spec of ACTOR_SPECS) {
    actors[spec.key] = await createActor(
      service,
      runId,
      spec,
      spec.orgKey === 'A' ? orgA.orgId : orgB.orgId,
    );
  }

  // `support` is the lowest rank that may hold a grant at all (0014), so it is
  // the rank that exercises both halves of the design: locked out without one,
  // scoped to exactly one org with one.
  const staff = await createStaffActor(service, runId, 'support');

  return { runId, service, orgA, orgB, actors: actors as Record<ActorKey, TestActor>, staff };
}

/**
 * Child tables in FK-safe order. `orgs` cascades, but we clear the children
 * explicitly so that a failure at the org row (see teardownWorld) still leaves
 * the smallest possible residue.
 */
const CHILD_DELETE_ORDER: readonly string[] = [
  'tracker_positions',
  'trackers',
  'device_health',
  'readings_daily',
  'readings_hourly',
  'readings',
  'device_calibrations',
  'gateways',
  'raw_events',
  'dead_letter_events',
  'audit_log',
  'hardware_orders',
  'subscriptions',
  'alerts',
  'alert_rules',
  'gate_events',
  'water_events',
  'bale_movements',
  'feed_inventory',
  'farm_bale_calibrations',
  'feed_events',
  'feed_schedules',
  'bale_types',
  'head_count_events',
  'group_placements',
  'groups',
  'feature_links',
  'map_features',
  'devices',
  'farms',
];

export interface TeardownReport {
  readonly failures: string[];
  readonly residue: string[];
}

export async function teardownWorld(world: World): Promise<TeardownReport> {
  const { service, orgA, orgB } = world;
  const orgIds = [orgA.orgId, orgB.orgId];
  const farmIds = [orgA.farmId, orgB.farmId];
  const failures: string[] = [];
  const residue: string[] = [];

  const swallow = async (
    label: string,
    run: () => PromiseLike<{ error: unknown }>,
  ): Promise<void> => {
    try {
      const { error } = await run();
      if (error) failures.push(`${label}: ${(error as { message?: string }).message ?? error}`);
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ingest_event_ids has no org_id at all
  await swallow('delete ingest_event_ids', () =>
    service.from('ingest_event_ids').delete().in('farm_id', farmIds),
  );

  for (const table of CHILD_DELETE_ORDER) {
    await swallow(`delete ${table}`, () => service.from(table).delete().in('org_id', orgIds));
  }

  // Non-owner memberships go first: app.protect_last_owner (0001) refuses to
  // let the final owner row leave, and it fires on cascade deletes too.
  await swallow('delete org_members (non-owner)', () =>
    service.from('org_members').delete().in('org_id', orgIds).neq('role', 'owner'),
  );
  await swallow('delete org_members (owner)', () =>
    service.from('org_members').delete().in('org_id', orgIds).eq('role', 'owner'),
  );
  await swallow('delete orgs', () => service.from('orgs').delete().in('id', orgIds));

  // The staff actor's impersonation grants are keyed on org, so the audit_log
  // sweep above already took them; this only removes the account itself. It is
  // not in `world.actors` (it has no org and no member role) so it needs its
  // own line — a staff account left behind would be a real staff account.
  const staffDelete = await service.auth.admin.deleteUser(world.staff.userId);
  if (staffDelete.error) {
    failures.push(`delete staff user ${world.staff.email}: ${staffDelete.error.message}`);
  }

  for (const actor of Object.values(world.actors)) {
    const { error } = await service.auth.admin.deleteUser(actor.userId);
    if (error) failures.push(`delete user ${actor.email}: ${error.message}`);
  }

  // What actually survived?
  const leftOrgs = await service.from('orgs').select('id,name').in('id', orgIds);
  if (leftOrgs.error) {
    failures.push(`residue check (orgs): ${leftOrgs.error.message}`);
  } else {
    for (const row of (leftOrgs.data ?? []) as Row[]) residue.push(`orgs/${String(row['id'])}`);
  }
  for (const { table, column } of NON_CASCADING_TABLES) {
    const ids = column === 'org_id' ? orgIds : farmIds;
    const { count, error } = await service
      .from(table)
      .select('*', { count: 'exact', head: true })
      .in(column, ids);
    if (error) failures.push(`residue check (${table}): ${error.message}`);
    else if ((count ?? 0) > 0) residue.push(`${table} × ${count}`);
  }

  if (residue.length > 0) {
    console.warn(
      [
        '',
        `[rls] teardown left rows behind for run ${world.runId}:`,
        ...residue.map((r) => `        ${r}`),
        ...(failures.length ? ['      caused by:', ...failures.map((f) => `        ${f}`)] : []),
        '      If the cause is app.protect_last_owner, an org that still has an',
        '      owner cannot be deleted through the data API at all — the trigger',
        '      fires on the ON DELETE CASCADE from orgs/auth.users. Purge with:',
        '        alter table org_members disable trigger protect_last_owner;',
        `        delete from orgs where name like 'RLS suite ${world.runId}%';`,
        '        alter table org_members enable trigger protect_last_owner;',
        '',
      ].join('\n'),
    );
  }

  return { failures, residue };
}
