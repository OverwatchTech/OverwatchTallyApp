import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { boundsOfGeometries, fetchMapFeatures, toFeatureCollection } from '@/lib/map/features';
import { FarmMap } from './farm-map';

export default async function FarmMapPage({ params }: { params: Promise<{ farmId: string }> }) {
  const { farmId } = await params;
  const supabase = await createClient();

  // boundary comes back as GeoJSON (PostGIS jsonb cast) and frames the map;
  // when a farm has no boundary yet we fall back to the feature extent.
  const { data: farm, error } = await supabase
    .from('farms')
    .select('id, name, boundary')
    .eq('id', farmId)
    .single();

  if (error || !farm) notFound();

  const rows = await fetchMapFeatures(supabase, farmId);
  const collection = toFeatureCollection(rows);
  const bounds =
    boundsOfGeometries([farm.boundary]) ??
    boundsOfGeometries(collection.features.map((f) => f.geometry));

  return (
    <div className="-m-8 flex h-screen flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline bg-background px-6 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="type-display text-base">{farm.name}</h1>
          <span className="machine text-xs text-muted">
            {rows.length} {rows.length === 1 ? 'feature' : 'features'}
          </span>
        </div>
        <Link
          href={`/farms/${farm.id}`}
          className="shrink-0 rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          Back to farm
        </Link>
      </header>

      {rows.length > 0 && bounds ? (
        <div className="relative min-h-0 flex-1">
          <FarmMap collection={collection} bounds={bounds} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md rounded-lg border border-hairline bg-card p-6">
            <h2 className="mb-1 text-base font-medium">No map yet</h2>
            <p className="text-sm text-muted">
              Your installer sketches the pens, alleys, gates, and water on this farm during setup.
              The map shows up here as soon as that sketch is saved — nothing for you to do.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
