// The two credential tables the generated types have not caught up with.
//
// `packages/db/src/database.types.ts` regenerates against the live database and
// is owned by packages/* — this phase does not touch it, and it predates
// migration 0010 (`mdp_webhook_credentials`) and 0011 (`mdp_app_credentials`,
// written by this phase and NOT yet applied).
//
// WHY NOT A SYNTHESIZED `Database` TYPE. The obvious move is to graft the two
// tables onto the generated Database and cast the client to
// `SupabaseClient<Extended>`. It does not work: supabase-js validates the
// schema against `Record<string, GenericView>` and friends, which only passes
// through TypeScript's implicit index signature — a courtesy extended to the
// generated object literal itself and lost the moment the type is rebuilt
// through `Omit` or property-by-property. The failure is silent: every row
// resolves to `never` and the errors point at the call sites, not the cause.
//
// So instead: two functions, each with its result type written out. Casting is
// confined to the one line where `from()` is handed a table name the generated
// types do not know, and every caller gets a real type.
//
// When `pnpm db:types` next runs against a database carrying 0010 and 0011,
// delete this file and use the generated tables directly.
import type { AdminClient } from './guard';

export interface MdpWebhookCredentialsRow {
  farm_id: string;
  webhook_uuid: string;
  webhook_secret: string;
  rotated_at: string;
}

export interface MdpAppCredentialsRow {
  farm_id: string;
  server_address: string;
  client_id: string;
  client_secret: string;
  rotated_at: string;
}

export type CredentialTable = 'mdp_webhook_credentials' | 'mdp_app_credentials';

export interface QueryError {
  message: string;
  code?: string;
}

export interface Result<T> {
  data: T | null;
  error: QueryError | null;
}

/** The slice of the PostgREST builder these two tables need. */
interface NarrowBuilder<Row> {
  select(columns: string): {
    eq(
      column: 'farm_id',
      value: string,
    ): { maybeSingle(): Promise<Result<Row>> };
  };
  upsert(
    values: Row,
    options: { onConflict: string },
  ): { select(columns: string): { single(): Promise<Result<{ farm_id: string }>> } };
}

function table<Row>(supabase: AdminClient, name: CredentialTable): NarrowBuilder<Row> {
  const from = supabase.from as unknown as (relation: string) => NarrowBuilder<Row>;
  return from(name);
}

export function readWebhookCredentials(
  supabase: AdminClient,
  farmId: string,
): Promise<Result<MdpWebhookCredentialsRow>> {
  return table<MdpWebhookCredentialsRow>(supabase, 'mdp_webhook_credentials')
    .select('farm_id, webhook_uuid, webhook_secret, rotated_at')
    .eq('farm_id', farmId)
    .maybeSingle();
}

export function readAppCredentials(
  supabase: AdminClient,
  farmId: string,
): Promise<Result<MdpAppCredentialsRow>> {
  return table<MdpAppCredentialsRow>(supabase, 'mdp_app_credentials')
    .select('farm_id, server_address, client_id, client_secret, rotated_at')
    .eq('farm_id', farmId)
    .maybeSingle();
}

export function upsertWebhookCredentials(
  supabase: AdminClient,
  row: MdpWebhookCredentialsRow,
): Promise<Result<{ farm_id: string }>> {
  return table<MdpWebhookCredentialsRow>(supabase, 'mdp_webhook_credentials')
    .upsert(row, { onConflict: 'farm_id' })
    .select('farm_id')
    .single();
}

export function upsertAppCredentials(
  supabase: AdminClient,
  row: MdpAppCredentialsRow,
): Promise<Result<{ farm_id: string }>> {
  return table<MdpAppCredentialsRow>(supabase, 'mdp_app_credentials')
    .upsert(row, { onConflict: 'farm_id' })
    .select('farm_id')
    .single();
}

/** True when the failure is "that table is not in the database yet". */
export function isMissingTable(error: QueryError | null): boolean {
  if (!error) return false;
  return error.code === '42P01' || /does not exist|schema cache/i.test(error.message);
}
