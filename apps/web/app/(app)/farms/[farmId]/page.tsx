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
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="type-display text-xl">{farm.name}</h1>
          <p className="machine mt-2 text-xs text-muted">
            {farm.status}
            {farm.subscription_tier ? ` · ${formatTier(farm.subscription_tier)}` : ''}
            {` · ${farm.timezone}`}
          </p>
        </div>
        <Link
          href={`/farms/${farm.id}/map`}
          className="shrink-0 rounded-md border border-hairline px-3 py-1.5 text-sm text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          Open map
        </Link>
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
