'use client';

// Dispensed vs scheduled, by pen and day. Bars are measured feed (teal
// family — never hay); the scheduled target renders as a neutral dashed
// line and only when a schedule with a target weight exists.

import {
  Bar,
  ComposedChart,
  CartesianGrid,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMeasure } from '@overwatch/ui';
import { chart, MONO_STACK, penSeriesColor } from '@/lib/ops/palette';

export interface FeedChartRow {
  label: string;
  scheduled: number | null;
  [penName: string]: string | number | null;
}

const tickStyle = { fill: chart.tick, fontFamily: MONO_STACK, fontSize: 10 };

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
    <div className="h-72 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={chart.grid} vertical={false} />
          <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={{ stroke: chart.grid }} />
          <YAxis
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={(v: number) => formatMeasure(v, 'kg', { digits: 0 })}
          />
          <Tooltip
            cursor={{ fill: 'rgba(247, 248, 245, 0.04)' }}
            contentStyle={{
              background: chart.tooltipBg,
              border: `1px solid ${chart.tooltipBorder}`,
              borderRadius: 8,
              fontFamily: MONO_STACK,
              fontSize: 11,
            }}
            labelStyle={{ color: chart.tick, fontFamily: MONO_STACK, fontSize: 10 }}
            formatter={(value) =>
              typeof value === 'number' ? formatMeasure(value, 'kg', { digits: 0 }) : String(value)
            }
          />
          <Legend
            wrapperStyle={{ fontFamily: MONO_STACK, fontSize: 11, color: chart.tick }}
            iconSize={9}
          />
          {penNames.map((pen, i) => (
            <Bar key={pen} dataKey={pen} stackId="fed" fill={penSeriesColor(i)} maxBarSize={26} />
          ))}
          {showScheduleLine && (
            <Line
              type="stepAfter"
              dataKey="scheduled"
              name="Scheduled"
              stroke={chart.reference}
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
