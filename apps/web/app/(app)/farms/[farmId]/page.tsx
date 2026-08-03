import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { claimsFromSession, isManagerOrOwner } from '@/lib/auth/claims';
import { formatTier } from '@/lib/format';
import { FarmForm } from './farm-form';

export default async function FarmPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  const { data: farm, error } = await supabase
    .from('farms')
    .select('id, name, status, subscription_tier, timezone')
    .eq('id', farmId)
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
        <h1 className="type-display text-xl">{farm.name}</h1>
        <p className="machine mt-2 text-xs text-muted">
          {farm.status}
          {farm.subscription_tier ? ` · ${formatTier(farm.subscription_tier)}` : ''}
          {` · ${farm.timezone}`}
        </p>
        {/* Quiet map links. Import and boundary are manager surfaces, so the
            links only show when they'd work; Download streams the caller's
            RLS-scoped view of the map from the KML route. */}
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <Link
            href={`/farms/${farm.id}/map`}
            className="transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Open map
          </Link>
          {canEdit && (
            <>
              <span aria-hidden className="text-faint">
                ·
              </span>
              <Link
                href={`/farms/${farm.id}/import`}
                className="transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                Import KML
              </Link>
            </>
          )}
          <span aria-hidden className="text-faint">
            ·
          </span>
          <a
            href={`/api/farms/${farm.id}/kml`}
            className="transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Download KML
          </a>
          {canEdit && (
            <>
              <span aria-hidden className="text-faint">
                ·
              </span>
              <Link
                href={`/farms/${farm.id}/boundary`}
                className="transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                Set boundary
              </Link>
            </>
          )}
        </p>
      </header>

      <section className="rounded-lg border border-hairline bg-card p-6">
        <h2 className="mb-1 text-base font-medium">Sensors reporting soon</h2>
        <p className="text-sm text-muted">
          Once your sensors are installed and checked, bunk, trough, and head counts start showing
          up here on their own.
        </p>
      </section>

      {canEdit ? (
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="mb-4 text-base font-medium">Farm details</h2>
          <FarmForm farmId={farm.id} name={farm.name} timezone={farm.timezone} />
        </section>
      ) : (
        <section className="rounded-lg border border-hairline bg-card p-6">
          <h2 className="mb-1 text-base font-medium">Farm details</h2>
          <p className="text-sm text-muted">
            Name and timezone changes need a manager or the owner.
          </p>
        </section>
      )}
    </div>
  );
}
