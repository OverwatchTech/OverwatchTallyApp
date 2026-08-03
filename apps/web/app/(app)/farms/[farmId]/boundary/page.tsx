// Legal-boundary onboarding (Phase 2). Owner and manager only — the gate
// here is UX; RLS on farms (manager update) and map_features (manager
// insert) is the enforcement.
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { claimsFromSession, isManagerOrOwner } from "@/lib/auth/claims";
import { formatAcres, geometryAreaM2, parseGeometry } from "@/lib/geo/geometry";
import { BoundaryFlow } from "./boundary-flow";

export default async function BoundaryPage({
  params,
}: {
  params: Promise<{ farmId: string }>;
}) {
  const { farmId } = await params;
  const supabase = await createClient();

  const { data: farm, error } = await supabase
    .from("farms")
    .select("id, name, boundary, centroid, parcel_apn")
    .eq("id", farmId)
    .single();
  if (error || !farm) notFound();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  const canEdit = isManagerOrOwner(claims.memberRole);

  const boundary = parseGeometry(farm.boundary);
  const boundaryAreaM2 = geometryAreaM2(boundary);
  const hasBoundary = boundary !== null && boundaryAreaM2 > 0;
  const centroid = parseGeometry(farm.centroid);
  const centroidAvailable = centroid?.type === "Point";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-xs text-muted">
          <Link href={`/farms/${farm.id}`} className="transition-colors hover:text-accent">
            {farm.name}
          </Link>
        </p>
        <h1 className="type-display mt-1 text-xl">Farm boundary</h1>
        <p className="mt-2 text-sm text-muted">
          The boundary comes from the county&apos;s recorded parcels — the legal line, not a
          guess drawn over imagery.
        </p>
      </header>

      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-1 text-base font-medium">Current boundary</h2>
        {hasBoundary ? (
          <div className="space-y-1">
            <p className="machine text-sm text-foreground">about {formatAcres(boundaryAreaM2)}</p>
            {farm.parcel_apn && (
              <p className="machine text-xs text-muted">
                {farm.parcel_apn.includes(",") ? "parcels" : "parcel"} {farm.parcel_apn}
              </p>
            )}
            <p className="text-xs text-faint">
              Setting it again replaces the whole boundary.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted">No boundary set yet.</p>
        )}
      </section>

      {canEdit ? (
        <BoundaryFlow
          farmId={farm.id}
          centroidAvailable={centroidAvailable}
          hasBoundary={hasBoundary}
        />
      ) : (
        <section className="rounded-lg border border-hairline bg-card p-6">
          <p className="text-sm text-muted">
            Setting the boundary needs a manager or the owner.
          </p>
        </section>
      )}
    </div>
  );
}
