// Raw event rate. Plain SVG, rendered on the server — a chart this simple
// does not need a client bundle, and the ingest screen has to load when
// something is already going wrong.
//
// Stacked by outcome: normalized (teal — live data arriving and landing),
// ignored (grey — acknowledged, not data), dead-lettered (alert — actually
// wrong). Colour follows CLAUDE.md #4 and nothing here is decorative.
//
// `tokens` rather than var(--ok) because these are SVG fills generated in
// TypeScript, which is the one place a custom property cannot reach.
import { Legend, LegendSwatch, tokens } from '@overwatch/ui';
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
    <figure className="ow-bd">
      <svg
        viewBox={`0 0 ${width} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Raw events per ${label} over the last ${rate.windowHours} hours. Peak ${peak}.`}
        style={{ height: '96px', width: '100%', display: 'block' }}
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
            { h: normalized, fill: tokens.ok, opacity: 0.85 },
            { h: pending, fill: tokens.ink3, opacity: 0.45 },
            { h: ignored, fill: tokens.ink2, opacity: 0.5 },
            { h: dead, fill: tokens.crit, opacity: 0.95 },
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

      <figcaption
        className="ow-inline"
        style={{ justifyContent: 'space-between', marginTop: '9px' }}
      >
        <span className="ow-quiet ow-machine">
          {rate.total.toLocaleString('en-US')} events · peak {peak.toLocaleString('en-US')} per{' '}
          {label}
        </span>
        <Legend>
          <LegendSwatch tone="ok">normalized</LegendSwatch>
          <LegendSwatch color={tokens.ink2}>ignored</LegendSwatch>
          <LegendSwatch tone="crit">dead-lettered</LegendSwatch>
        </Legend>
      </figcaption>

      {rate.capped && (
        <p className="ow-quiet ow-wrong" style={{ marginTop: '7px' }}>
          The scan stopped at {rate.total.toLocaleString('en-US')} rows. Every bar is a floor, not a
          count — narrow the window for a true figure.
        </p>
      )}
    </figure>
  );
}
