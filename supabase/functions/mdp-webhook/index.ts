// mdp-webhook — Supabase Edge Function (Deno). Built in Phase 4.
//
// Hard requirements (docs/ARCHITECTURE.md §5):
//   /mdp-webhook/{farm_token} path secret · reject unknown devEUI ·
//   rate-limit per token · validate envelope · idempotent on eventID ·
//   persist raw before normalize · dead-letter failures · 2xx fast ·
//   received_at vs event_created_time · TelemetrySource abstraction.
//
// service_role is permitted here (one of exactly two places).

Deno.serve(() => new Response('not implemented — phase 4', { status: 501 }));
