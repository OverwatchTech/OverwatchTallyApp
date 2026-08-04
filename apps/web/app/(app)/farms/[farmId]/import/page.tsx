// KML import (Phase 2). Owner and manager only — the gate here is UX; RLS on
// map_features (manager_insert) is the enforcement, so a forged request from
// any other role inserts nothing.
//
// Composition is the approved mockup: Pad → PageHeader → Cols, with the flow
// in the main column and the "what happens" explanation in the 340px rail.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Cols, Pad, PageHeader } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { ImportFlow } from './import-flow';
import '../boundary/setup-forms.css';

export default async function ImportPage({
  params,
}: {
  params: Promise<{ farmId: string }>;
}) {
  const { farmId } = await params;
  const supabase = await createClient();

  const { data: farm, error } = await supabase
    .from('farms')
    .select('id, name')
    .eq('id', farmId)
    .single();
  if (error || !farm) notFound();

  const {
    data: { session },
  } = await supabase.auth.getSession();
  const claims = claimsFromSession(session);
  const canEdit = isManagerOrOwner(claims.memberRole);

  return (
    <Pad>
      <PageHeader
        title="Import a KML file"
        sub={
          <>
            <b>{farm.name}</b> · bring pens, alleys, gates, and the rest of the map in from Google
            Earth. You review every feature before it lands.
          </>
        }
      />

      <Cols>
        <div>
          {canEdit ? (
            <ImportFlow farmId={farm.id} />
          ) : (
            <Card title="Import a map">
              <p className="ow-prose">Importing a map needs a manager or the owner.</p>
            </Card>
          )}
        </div>

        <div>
          <Card title="What happens" sub="nothing lands until you say so">
            <p className="ow-prose">
              Names come in exactly as written. The kind is a guess from the name; you correct it
              in the review list, and everything stays editable on the map afterwards.
            </p>
            <p className="ow-prose">
              A feature already on the map is skipped rather than duplicated.
            </p>
          </Card>

          <Card title="Go to" padded={false}>
            <div className="ow-bd" style={{ display: 'grid', gap: 6 }}>
              <Link href={`/farms/${farm.id}/map`} className="ow-prose">
                Site map
              </Link>
              <Link href={`/farms/${farm.id}/boundary`} className="ow-prose">
                Farm boundary
              </Link>
            </div>
          </Card>
        </div>
      </Cols>
    </Pad>
  );
}
