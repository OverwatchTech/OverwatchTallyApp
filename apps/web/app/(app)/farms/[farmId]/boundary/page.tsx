// Legal-boundary onboarding (Phase 2). Owner and manager only — the gate
// here is UX; RLS on farms (manager update) and map_features (manager
// insert) is the enforcement.
//
// Composition is the approved mockup (docs/reference/portal-mockup.html):
// Pad → PageHeader → Cols, with the flow in the main column and the current
// boundary in the 340px rail. Every sentence the pre-mockup screen carried is
// still here, in the same words.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Cols, Pad, PageHeader } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { formatAcres, geometryAreaM2, parseGeometry } from '@/lib/geo/geometry';
import { BoundaryFlow } from './boundary-flow';
import './setup-forms.css';

export default async function BoundaryPage({
  params,
}: {
  params: Promise<{ farmId: string }>;
}) {
  const { farmId } = await params;
  const supabase = await createClient();

  const { data: farm, error } = await supabase
    .from('farms')
    .select('id, name, boundary, centroid, parcel_apn')
    .eq('id', farmId)
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
  const centroidAvailable = centroid?.type === 'Point';

  return (
    <Pad>
      <PageHeader
        title="Farm boundary"
        sub={
          <>
            <b>{farm.name}</b> · the boundary comes from the county&apos;s recorded parcels — the
            legal line, not a guess drawn over imagery.
          </>
        }
      />

      <Cols>
        <div>
          {canEdit ? (
            <BoundaryFlow
              farmId={farm.id}
              centroidAvailable={centroidAvailable}
              hasBoundary={hasBoundary}
            />
          ) : (
            <Card title="Farm boundary">
              <p className="ow-prose">Setting the boundary needs a manager or the owner.</p>
            </Card>
          )}
        </div>

        <div>
          <Card
            title="Current boundary"
            note={hasBoundary ? <>Setting it again replaces the whole boundary.</> : undefined}
          >
            {hasBoundary ? (
              <>
                <div className="ow-bignum">≈ {formatAcres(boundaryAreaM2)}</div>
                {farm.parcel_apn && (
                  <p className="ow-prose faint">
                    {farm.parcel_apn.includes(',') ? 'parcels' : 'parcel'}{' '}
                    <span className="machine">{farm.parcel_apn}</span>
                  </p>
                )}
              </>
            ) : (
              <p className="ow-prose">No boundary set yet.</p>
            )}
          </Card>

          <Card title="Go to" padded={false}>
            <div className="ow-bd" style={{ display: 'grid', gap: 6 }}>
              <Link href={`/farms/${farm.id}/map`} className="ow-prose">
                Site map
              </Link>
              <Link href={`/farms/${farm.id}/import`} className="ow-prose">
                Import a KML file
              </Link>
            </div>
          </Card>
        </div>
      </Cols>
    </Pad>
  );
}
