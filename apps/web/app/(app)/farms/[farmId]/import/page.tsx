// KML import (Phase 2). Owner and manager only — the gate here is UX; RLS on
// map_features (manager_insert) is the enforcement, so a forged request from
// any other role inserts nothing.
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { claimsFromSession, isManagerOrOwner } from "@/lib/auth/claims";
import { ImportFlow } from "./import-flow";

export default async function ImportPage({
  params,
}: {
  params: Promise<{ farmId: string }>;
}) {
  const { farmId } = await params;
  const supabase = await createClient();

  const { data: farm, error } = await supabase
    .from("farms")
    .select("id, name")
    .eq("id", farmId)
    .single();
  if (error || !farm) notFound();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  const canEdit = isManagerOrOwner(claims.memberRole);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-xs text-muted">
          <Link href={`/farms/${farm.id}`} className="transition-colors hover:text-accent">
            {farm.name}
          </Link>
        </p>
        <h1 className="type-display mt-1 text-xl">Import a KML file</h1>
        <p className="mt-2 text-sm text-muted">
          Bring pens, alleys, gates, and the rest of the map in from Google Earth. You review
          every feature before it lands.
        </p>
      </header>

      {canEdit ? (
        <ImportFlow farmId={farm.id} />
      ) : (
        <section className="rounded-lg border border-hairline bg-card p-6">
          <p className="text-sm text-muted">Importing a map needs a manager or the owner.</p>
        </section>
      )}
    </div>
  );
}
