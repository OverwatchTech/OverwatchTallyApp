/**
 * Tenant-table inventory for the RLS attack suite.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ADDING A TABLE TO THE SCHEMA? ADD IT HERE IN THE SAME PULL REQUEST.
 *  A table that is not listed is a table nobody is attacking. Every table with
 *  a member-facing policy belongs in TENANT_TABLES; every table only staff (or
 *  the service role) may touch belongs in STAFF_ONLY_TABLES.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This list is hand-maintained on purpose: PostgREST exposes no way to read
 * pg_policies or pg_tables from a client, and the schema deliberately ships no
 * RPC that would. So there is nothing to introspect against — the list *is*
 * the guard, and it is only as good as the last person who edited the schema.
 *
 * The role arrays below mirror the policies exactly as written in
 * packages/db/migrations/*.sql (the `migration` field names the file). They are
 * documentation *and* assertions: `rls.test.ts` reads them, and the descriptor
 * consistency test fails if the inventory contradicts itself.
 *
 * Nothing here is secret and nothing here touches the network — this module is
 * importable from future phases (seed scripts, admin tooling, later test
 * suites) without pulling in a database client.
 */

export type MemberRole = 'owner' | 'manager' | 'crew' | 'viewer';

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'manager', 'crew', 'viewer'];
export const PLATFORM_ROLES = ['installer', 'support', 'admin'] as const;

/** Every member role — the standard `org_id = app.org_id()` read policy. */
const ALL_MEMBERS: readonly MemberRole[] = MEMBER_ROLES;
/** `app.member_role() in ('owner','manager')`. */
const MANAGER_UP: readonly MemberRole[] = ['owner', 'manager'];
/** `app.member_role() in ('owner','manager','crew')`. */
const CREW_UP: readonly MemberRole[] = ['owner', 'manager', 'crew'];
/** No member policy at all — staff or service role only. */
const NOBODY: readonly MemberRole[] = [];

/** Row ids the suite seeds per org; attack payloads reference the victim's. */
export interface FixtureIds {
  readonly orgId: string;
  readonly farmId: string;
  readonly penFeatureId: string;
  readonly gateFeatureId: string;
  readonly groupId: string;
  readonly feedInventoryId: string;
  readonly baleTypeId: string;
  readonly deviceId: string;
  /** A second device with no `device_health` row, so that probe cannot collide. */
  readonly spareDeviceId: string;
  readonly trackerId: string;
}

export interface AttackContext {
  /** Unique per test run — keeps parallel runs from colliding on unique keys. */
  readonly runId: string;
  /** The attacker's own auth.users id (org A owner). */
  readonly attackerUserId: string;
}

export interface TenantTable {
  readonly table: string;
  /** Column carrying tenancy. `orgs` is itself the tenant, keyed on `id`. */
  readonly tenantColumn: 'org_id' | 'id';
  readonly migration: string;
  readonly memberRead: readonly MemberRole[];
  readonly memberInsert: readonly MemberRole[];
  readonly memberUpdate: readonly MemberRole[];
  readonly memberDelete: readonly MemberRole[];
  /** A row that would land in the victim org if RLS let it through. */
  readonly crossTenantRow: (victim: FixtureIds, ctx: AttackContext) => Record<string, unknown>;
  /** Harmless-looking patch for the cross-tenant UPDATE probe. */
  readonly patch: Record<string, unknown>;
  /** Notes worth carrying next to the policy. */
  readonly note?: string;
}

const iso = (): string => new Date().toISOString();
const hourIso = (): string => {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
};
const POINT = 'SRID=4326;POINT(-104.912 40.501)';
const POLYGON =
  'SRID=4326;POLYGON((-104.912 40.501,-104.902 40.501,-104.902 40.511,-104.912 40.511,-104.912 40.501))';
const rangeNow = (): string => {
  const end = new Date();
  const start = new Date(end.getTime() - 3_600_000);
  return `["${start.toISOString()}","${end.toISOString()}")`;
};

export const TENANT_TABLES: readonly TenantTable[] = [
  // ── 0001_foundation ───────────────────────────────────────────────────────
  {
    table: 'orgs',
    tenantColumn: 'id',
    migration: '0001_foundation.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY, // no INSERT policy exists for `authenticated`
    memberUpdate: ['owner'],
    memberDelete: NOBODY,
    note: 'orgs is keyed on id, so the INSERT probe simply asks whether a member can mint an org at all.',
    crossTenantRow: (_v, ctx) => ({ name: `${ctx.runId} attack org` }),
    patch: { name: 'pwned' },
  },
  {
    table: 'org_members',
    tenantColumn: 'org_id',
    migration: '0001_foundation.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: ['owner'],
    memberUpdate: ['owner'],
    memberDelete: ['owner'],
    crossTenantRow: (v, ctx) => ({
      org_id: v.orgId,
      user_id: ctx.attackerUserId,
      role: 'owner',
    }),
    patch: { role: 'viewer' },
  },
  {
    table: 'farms',
    tenantColumn: 'org_id',
    migration: '0001_foundation.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY, // farm creation is installer-led
    memberUpdate: MANAGER_UP,
    memberDelete: NOBODY,
    crossTenantRow: (v, ctx) => ({ org_id: v.orgId, name: `${ctx.runId} attack farm` }),
    patch: { name: 'pwned' },
  },

  // ── 0002_map_livestock (member read · manager+ write) ─────────────────────
  {
    table: 'map_features',
    tenantColumn: 'org_id',
    migration: '0002_map_livestock.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v, ctx) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      kind: 'pen',
      name: `${ctx.runId} attack pen`,
      geom: POLYGON,
    }),
    patch: { name: 'pwned' },
  },
  {
    table: 'feature_links',
    tenantColumn: 'org_id',
    migration: '0002_map_livestock.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      from_feature_id: v.penFeatureId,
      to_feature_id: v.gateFeatureId,
      relation: 'adjacent', // the fixture link uses 'connects'; stay off its unique key
    }),
    patch: { relation: 'contains' },
  },
  {
    table: 'groups',
    tenantColumn: 'org_id',
    migration: '0002_map_livestock.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v, ctx) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      name: `${ctx.runId} attack group`,
    }),
    patch: { name: 'pwned' },
  },
  {
    table: 'group_placements',
    tenantColumn: 'org_id',
    migration: '0002_map_livestock.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    note: 'valid range is deliberately historic — the fixture placement is now→∞ and the table carries an exclusion constraint.',
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      group_id: v.groupId,
      pen_feature_id: v.penFeatureId,
      valid: '["2001-01-01T00:00:00Z","2001-01-02T00:00:00Z")',
    }),
    patch: { valid: '["2001-06-01T00:00:00Z","2001-06-02T00:00:00Z")' },
  },
  {
    table: 'head_count_events',
    tenantColumn: 'org_id',
    migration: '0002_map_livestock.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      group_id: v.groupId,
      delta: 7,
      reason: 'arrival',
    }),
    patch: { notes: 'pwned' },
  },

  // ── 0004_operations_billing (member read · manager+ write) ────────────────
  {
    table: 'feed_schedules',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      pen_feature_id: v.penFeatureId, // exactly one of pen/group per check constraint
      target_kg: 12,
    }),
    patch: { active: false },
  },
  {
    table: 'feed_events',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: CREW_UP, // crew log feedings — that is their job
    memberUpdate: MANAGER_UP,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      pen_feature_id: v.penFeatureId,
      amount_kg: 40,
      source: 'crew_logged',
    }),
    patch: { confidence: 0.01 },
  },
  {
    table: 'bale_types',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: NOBODY,
    note: 'rows with org_id null are global seeds readable by everyone; the probes filter on org_id so they never see them.',
    crossTenantRow: (v, ctx) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      label: `${ctx.runId} attack bale`,
      shape: 'round',
      dim_a_m: 1.2192,
      dim_b_m: 1.524,
      nominal_weight_kg: 385.6,
    }),
    patch: { label: 'pwned' },
  },
  {
    table: 'farm_bale_calibrations',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      bale_type_id: v.baleTypeId,
      measured_weight_kg: 402.1,
    }),
    patch: { notes: 'pwned' },
  },
  {
    table: 'feed_inventory',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      feed_type: 'alfalfa',
      bale_type_id: v.baleTypeId,
    }),
    patch: { tiers: 9 },
  },
  {
    table: 'bale_movements',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      feed_inventory_id: v.feedInventoryId,
      delta: 25,
      reason: 'delivered',
    }),
    patch: { reason: 'correction' },
  },
  {
    table: 'alert_rules',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: MANAGER_UP,
    memberUpdate: MANAGER_UP,
    memberDelete: MANAGER_UP,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      kind: 'trough_low',
      severity: 'critical',
    }),
    patch: { enabled: false },
  },

  // ── 0004 (member read only — telemetry-derived / billing) ─────────────────
  {
    table: 'water_events',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      trough_feature_id: v.penFeatureId,
      interval_range: rangeNow(),
      volume_l: 120,
      method: 'pulse_count',
    }),
    patch: { volume_l: 1 },
  },
  {
    table: 'gate_events',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      gate_feature_id: v.gateFeatureId,
      state: 'open',
      occurred_at: iso(),
    }),
    patch: { attribution_confidence: 0.99 },
  },
  {
    table: 'subscriptions',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({ org_id: v.orgId, farm_id: v.farmId, status: 'active' }),
    patch: { status: 'pwned' },
  },
  {
    table: 'alerts',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY, // alerts are raised by the platform, never by a member
    memberUpdate: CREW_UP, // crew acknowledge alerts
    memberDelete: NOBODY,
    crossTenantRow: (v, ctx) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      kind: 'trough_low',
      severity: 'critical',
      dedup_key: `${ctx.runId}-attack`, // off the open-alert unique index
    }),
    patch: { severity: 'info' },
  },
  {
    table: 'hardware_orders',
    tenantColumn: 'org_id',
    migration: '0004_operations_billing.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({ org_id: v.orgId, farm_id: v.farmId, status: 'quote' }),
    patch: { notes: 'pwned' },
  },

  // ── 0003_devices_telemetry (member read · staff write) ────────────────────
  {
    table: 'devices',
    tenantColumn: 'org_id',
    migration: '0003_devices_telemetry.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY, // CLAUDE.md #12: customers never provision devices
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v, ctx) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      dev_eui: `${ctx.runId}ATTACK`.toUpperCase(),
      model: 'EM400-UDL',
      role: 'trough_level',
    }),
    patch: { sn: 'pwned' },
  },
  {
    table: 'readings',
    tenantColumn: 'org_id',
    migration: '0003_devices_telemetry.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      device_id: v.deviceId,
      metric: 'attack_distance_mm',
      value: 1,
      received_at: iso(),
    }),
    patch: { value: 999 },
  },
  {
    table: 'readings_hourly',
    tenantColumn: 'org_id',
    migration: '0003_devices_telemetry.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      device_id: v.deviceId,
      metric: 'attack_hourly',
      bucket_start: hourIso(),
      sample_count: 1,
    }),
    patch: { sample_count: 999 },
  },
  {
    table: 'readings_daily',
    tenantColumn: 'org_id',
    migration: '0003_devices_telemetry.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      device_id: v.deviceId,
      metric: 'attack_daily',
      bucket_start: new Date().toISOString().slice(0, 10),
      sample_count: 1,
    }),
    patch: { sample_count: 999 },
  },
  {
    table: 'device_health',
    tenantColumn: 'org_id',
    migration: '0003_devices_telemetry.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    note: 'primary key is device_id — the probe targets the spare device so it cannot trip a duplicate key first.',
    crossTenantRow: (v) => ({
      device_id: v.spareDeviceId,
      org_id: v.orgId,
      farm_id: v.farmId,
      online: true,
    }),
    patch: { online: false },
  },
  {
    table: 'trackers',
    tenantColumn: 'org_id',
    migration: '0003_devices_telemetry.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v, ctx) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      label: `${ctx.runId} attack tracker`,
      source: 'mdp',
    }),
    patch: { label: 'pwned' },
  },
  {
    table: 'tracker_positions',
    tenantColumn: 'org_id',
    migration: '0003_devices_telemetry.sql',
    memberRead: ALL_MEMBERS,
    memberInsert: NOBODY,
    memberUpdate: NOBODY,
    memberDelete: NOBODY,
    crossTenantRow: (v) => ({
      org_id: v.orgId,
      farm_id: v.farmId,
      tracker_id: v.trackerId,
      recorded_at: iso(),
      geom: POINT,
      source: 'mdp',
    }),
    patch: { speed_mps: 99 },
  },
];

/**
 * Tables no member may read at all — they exist for staff and the two edge
 * functions that hold the service role. A member SELECT must come back empty
 * even though the service role can see seeded rows.
 */
export interface StaffOnlyTable {
  readonly table: string;
  /** Column the seeded fixture row is found by, for the service-side control. */
  readonly tenantColumn: 'org_id' | 'farm_id';
  readonly migration: string;
  readonly note?: string;
}

export const STAFF_ONLY_TABLES: readonly StaffOnlyTable[] = [
  { table: 'audit_log', tenantColumn: 'org_id', migration: '0001_foundation.sql' },
  { table: 'gateways', tenantColumn: 'org_id', migration: '0003_devices_telemetry.sql' },
  { table: 'device_calibrations', tenantColumn: 'org_id', migration: '0003_devices_telemetry.sql' },
  { table: 'raw_events', tenantColumn: 'org_id', migration: '0003_devices_telemetry.sql' },
  { table: 'dead_letter_events', tenantColumn: 'org_id', migration: '0003_devices_telemetry.sql' },
  {
    table: 'ingest_event_ids',
    tenantColumn: 'farm_id',
    migration: '0003_devices_telemetry.sql',
    note: 'RLS enabled with no policies at all — service-role only by design.',
  },
];

/** Tables whose rows do not disappear when their org is deleted (no FK). */
export const NON_CASCADING_TABLES: readonly { table: string; column: 'org_id' | 'farm_id' }[] = [
  { table: 'audit_log', column: 'org_id' },
  { table: 'raw_events', column: 'org_id' },
  { table: 'dead_letter_events', column: 'org_id' },
  { table: 'readings', column: 'org_id' },
  { table: 'readings_hourly', column: 'org_id' },
  { table: 'readings_daily', column: 'org_id' },
  { table: 'tracker_positions', column: 'org_id' },
  { table: 'device_health', column: 'org_id' },
  { table: 'ingest_event_ids', column: 'farm_id' },
];
