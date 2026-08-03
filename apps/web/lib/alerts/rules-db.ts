// Reads and the one write that is not a plain table update.
//
// `alert_rules` is in the generated types, so it needs no help. The RPC does:
// `public.seed_default_alert_rules(uuid)` arrived in migration 0011, after
// the last `pnpm db:types` run, so `supabase.rpc()` does not know its name.
// The cast is confined to the one line, exactly as in
// `apps/web/lib/admin/db-extras.ts`. Delete it when the types regenerate.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@overwatch/db';

import type { Severity } from './kinds';

type Client = SupabaseClient<Database>;

export interface RuleRow {
  id: string;
  farm_id: string;
  kind: string;
  severity: Severity;
  enabled: boolean;
  params: Json;
  quiet_hours: Json | null;
  escalation: Json | null;
}

const COLUMNS = 'id, farm_id, kind, severity, enabled, params, quiet_hours, escalation';

/** Every rule the caller may read; RLS scopes it to their org. */
export async function fetchRules(supabase: Client): Promise<RuleRow[]> {
  const { data } = await supabase.from('alert_rules').select(COLUMNS).order('kind');
  return (data ?? []) as RuleRow[];
}

/** rule id → the rule, for the alerts screen's "which rule was this" line. */
export function ruleIndex(rules: readonly RuleRow[]): Map<string, RuleRow> {
  const index = new Map<string, RuleRow>();
  for (const rule of rules) index.set(rule.id, rule);
  return index;
}

export interface RpcResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

// `.bind(supabase)` is load-bearing: `rpc` reads `this.rest`, and a bare
// reference throws at request time while typechecking and building cleanly.
export function seedDefaultRules(supabase: Client, farmId: string): Promise<RpcResult> {
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<RpcResult>;
  return rpc('seed_default_alert_rules', { p_farm_id: farmId });
}
