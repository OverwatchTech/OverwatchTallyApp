// Shared header for the farm ops screens (feed / water / movement).
// Carries the cross-links between the three screens plus the way back to
// the farm and its map. App-shell nav integration is deferred to merge —
// the shell layout is owned elsewhere tonight; these tiles keep the
// screens reachable from each other in the meantime.

import Link from 'next/link';

const TABS = [
  { slug: 'feed', label: 'Feed' },
  { slug: 'water', label: 'Water' },
  { slug: 'movement', label: 'Movement' },
] as const;

export type OpsTab = (typeof TABS)[number]['slug'];

export function OpsHeader({
  farmId,
  farmName,
  timezone,
  active,
  subtitle,
}: {
  farmId: string;
  farmName: string;
  timezone: string;
  active: OpsTab;
  subtitle: string;
}) {
  return (
    <header className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="type-display text-xl">{farmName}</h1>
          <p className="machine mt-2 text-xs text-muted">
            {subtitle}
            {` · ${timezone}`}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href={`/farms/${farmId}`}
            className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Back to farm
          </Link>
          <Link
            href={`/farms/${farmId}/map`}
            className="rounded border border-hairline px-2 py-1 text-xs text-foreground transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
          >
            Open map
          </Link>
        </div>
      </div>

      <nav className="flex gap-1 border-b border-hairline" aria-label="Farm operations">
        {TABS.map((tab) => (
          <Link
            key={tab.slug}
            href={`/farms/${farmId}/${tab.slug}`}
            aria-current={tab.slug === active ? 'page' : undefined}
            className={
              tab.slug === active
                ? 'border-b-2 border-accent px-3 py-2 text-sm font-medium text-foreground'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-muted transition-colors hover:text-foreground'
            }
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
