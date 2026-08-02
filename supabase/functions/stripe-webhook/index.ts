// stripe-webhook — Supabase Edge Function (Deno). Built in Phase 7.
// Verify signature, process idempotently by event ID, mirror into
// `subscriptions` (Stripe is the source of truth).
// service_role is permitted here (one of exactly two places).

Deno.serve(() => new Response('not implemented — phase 7', { status: 501 }));
