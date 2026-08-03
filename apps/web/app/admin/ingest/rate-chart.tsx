// Raw event rate. Plain SVG, rendered on the server — a chart this simple
// does not need a client bundle, and the ingest screen has to load when
// something is already going wrong.
//
// Stacked by outcome: normalized (teal — live data arriving and landing),
// ignored (muted — acknowledged, not data), dead-lettered (alert — actually
// wrong). Colour follows CLAUDE.md #4 and nothing here is decorative.
import { tokens } from '@overwatch/ui';
import type { IngestRate } from '@/lib/admin/ingest';

const HEIGHT = 96;
const GAP = 1;

export function RateChart({ rate }: { rate: IngestRate }) {
  const buckets = rate.buckets;
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.total));
  const width = Math.max(buckets.length * 8, 240);
  const barWidth = Math.max(1, width / Math.max(1, buckets.length) - GAP);

  const label = rate.bucketMinutes >= 60 ? `${rate.bucketMinutes / 60}h` : `${rate.bucketMinutes}m`;

  return (
    <figure className="space-y-2 px-4 py-4">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Raw events per ${label} over the last ${rate.windowHours} hours. Peak ${peak}.`}
        className="h-24 w-full"
      >
        {buckets.map((bucket, index) => {
          const x = index * (barWidth + GAP);
          const scale = (value: number) => (value / peak) * HEIGHT;
          const dead = scale(bucket.deadLetter);
          const ignored = scale(bucket.ignored);
          const pending = scale(bucket.pending);
          const normalized = scale(bucket.normalized);

          let y = HEIGHT;
          const segments: { h: number; fill: string; opacity: number }[] = [
            { h: normalized, fill: tokens.teal, opacity: 0.85 },
            { h: pending, fill: tokens.paper, opacity: 0.25 },
            { h: ignored, fill: tokens.paper, opacity: 0.4 },
            { h: dead, fill: tokens.alert, opacity: 0.95 },
          ];

          return (
            <g key={bucket.start}>
              {segments.map((segment, segmentIndex) => {
                if (segment.h <= 0) return null;
                y -= segment.h;
                return (
                  <rect
                    key={segmentIndex}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={segment.h}
                    fill={segment.fill}
                    opacity={segment.opacity}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted">
        <span className="machine">
          {rate.total.toLocaleString('en-US')} events · peak {peak.toLocaleString('en-US')} per{' '}
          {label}
        </span>
        <span className="flex flex-wrap gap-3">
          <Key color={tokens.teal} label="normalized" />
          <Key color={tokens.paper} label="ignored" faded />
          <Key color={tokens.alert} label="dead-lettered" />
        </span>
      </figcaption>

      {rate.capped && (
        <p className="text-xs text-alert">
          The scan stopped at {rate.total.toLocaleString('en-US')} rows. Every bar is a floor, not a
          count — narrow the window for a true figure.
        </p>
      )}
    </figure>
  );
}

function Key({ color, label, faded }: { color: string; label: string; faded?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span
        aria-hidden
        className="inline-block h-2 w-2 rounded-[1px]"
        style={{ backgroundColor: color, opacity: faded ? 0.4 : 0.9 }}
      />
      {label}
    </span>
  );
}
