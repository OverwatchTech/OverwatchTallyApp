// Browser Supabase client. Anon key only — service_role never enters apps/web
// (CLAUDE.md #9).
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@overwatch/db";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
