'use client';

// Dispensed vs scheduled, by pen and day. Bars are measured feed (teal
// family — never hay); the scheduled target renders as a neutral dashed
// line and only when a schedule with a target weight exists.
//
// RE-SKIN NOTE. The chart itself is unchanged — same series, same units,
// same stacking. What changed is the chrome, to the mockup's two chart
// classes and nothing more:
//
//   .axis  font-family: var(--mono); font-size: 10px; fill: var(--ink3)
//   .gl    stroke: rgba(255,255,255,.06)
//
// The axis rule is applied as a CSS class (ops.module.css `.axis`), not as
// SVG presentation attributes, for two reasons: a CSS rule beats a
// presentation attribute so Recharts' own defaults cannot win, and `fill`
// and `font-family` can then reference --ink3 and --mono instead of a
// hard-coded copy of them that would drift from the token.
//
// The legend moved OUT of the chart and into the Card's `.hd`, where the
// mockup puts it. Recharts' <Legend> is gone; the pen colours the card
// header shows come from the same `penSeriesColor` this file draws with.

import {
  Bar,
  ComposedChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMeasure } from '@overwatch/ui';
import { penSeriesColor } from '@/lib/ops/palette';

import styles from './ops.module.css';

export interface FeedChartRow {
  label: string;
  scheduled: number | null;
  [penName: string]: string | number | null;
}

/** The mockup's `.gl`. */
const GRIDLINE = 'rgba(255,255,255,.06)';
/** A plan is not a projection and not a measurement — neutral, never hay. */
const SCHEDULE_LINE = 'rgba(255,255,255,.55)';

const tick = { className: styles.axis };

export function FeedChart({
  data,
  penNames,
  showScheduleLine,
}: {
  data: FeedChartRow[];
  penNames: string[];
  showScheduleLine: boolean;
}) {
  return (
    <div className={styles.chart}>
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRIDLINE} vertical={false} />
          <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: GRIDLINE }} />
          <YAxis
            tick={tick}
            tickLine={false}
            axisLine={false}
            width={66}
            tickFormatter={(v: number) => formatMeasure(v, 'kg', { digits: 0 })}
          />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,.04)' }}
            contentStyle={{
              background: '#171c23',
              border: '1px solid rgba(255,255,255,.13)',
              borderRadius: 11,
              boxShadow: '0 12px 36px rgba(0,0,0,.5)',
              fontFamily: 'var(--mono)',
              fontSize: 11,
              padding: '9px 12px',
            }}
            itemStyle={{ padding: '1px 0' }}
            labelStyle={{ color: '#5d6873', fontFamily: 'var(--mono)', fontSize: 10.5 }}
            formatter={(value) =>
              typeof value === 'number' ? formatMeasure(value, 'kg', { digits: 0 }) : String(value)
            }
          />
          {penNames.map((pen, i) => (
            <Bar key={pen} dataKey={pen} stackId="fed" fill={penSeriesColor(i)} maxBarSize={26} />
          ))}
          {showScheduleLine && (
            <Line
              type="stepAfter"
              dataKey="scheduled"
              name="Scheduled"
              stroke={SCHEDULE_LINE}
              strokeDasharray="6 4"
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
