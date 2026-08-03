'use client';

// Pen detail charts. Values arrive SI (mm, liters) and convert at the tick
// and tooltip through formatMeasure — the single conversion point
// (CLAUDE.md #6).
//
// Color (CLAUDE.md #4): the level trace is a *measured sensor distance*, not
// a liquid quantity, so it draws in the teal family (live measured data).
// Water blue is reserved for the actual metered volume chart below it. Hay
// never appears here — nothing on this screen is a projection.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatMeasure } from '@overwatch/ui';
import { chart, MONO_STACK, penSeriesColor } from '@/lib/ops/palette';

const tickStyle = { fill: chart.tick, fontFamily: MONO_STACK, fontSize: 10 };

const tooltipStyles = {
  cursor: { fill: 'rgba(247, 248, 245, 0.04)' },
  contentStyle: {
    background: chart.tooltipBg,
    border: `1px solid ${chart.tooltipBorder}`,
    borderRadius: 8,
    fontFamily: MONO_STACK,
    fontSize: 11,
  },
  labelStyle: { color: chart.tick, fontFamily: MONO_STACK, fontSize: 10 },
} as const;

export interface LevelRow {
  /** epoch ms */
  t: number;
  /** sensor-to-surface distance in mm, keyed by series label */
  [seriesLabel: string]: number;
}

/**
 * Sensor-to-surface distance over the window. The Y axis is inverted so a
 * fuller trough/bunk reads higher, which is how a rancher looks at it — the
 * caption on the page says exactly that, and says the number is uncalibrated.
 */
export function LevelTraceChart({
  data,
  seriesLabels,
  timezone,
}: {
  data: LevelRow[];
  seriesLabels: string[];
  timezone: string;
}) {
  const timeLabel = (t: number) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      hour12: false,
    }).format(new Date(t));

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={chart.grid} vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={['dataMin', 'dataMax']}
            tick={tickStyle}
            tickLine={false}
            axisLine={{ stroke: chart.grid }}
            tickFormatter={timeLabel}
            minTickGap={48}
          />
          <YAxis
            reversed
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            width={64}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => formatMeasure(v, 'mm', { digits: 0 })}
          />
          <Tooltip
            {...tooltipStyles}
            labelFormatter={(t) => (typeof t === 'number' ? timeLabel(t) : String(t))}
            formatter={(value) =>
              typeof value === 'number' ? `${formatMeasure(value, 'mm')} to surface` : String(value)
            }
          />
          <Legend
            wrapperStyle={{ fontFamily: MONO_STACK, fontSize: 11, color: chart.tick }}
            iconSize={9}
          />
          {seriesLabels.map((label, i) => (
            <Line
              key={label}
              dataKey={label}
              stroke={penSeriesColor(i)}
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface WaterRow {
  label: string;
  /** liters per head that day */
  perHead: number;
}

/** Metered water per head per day — liquid measurement, so water blue. */
export function WaterPerHeadChart({ data }: { data: WaterRow[] }) {
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={chart.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={tickStyle}
            tickLine={false}
            axisLine={{ stroke: chart.grid }}
          />
          <YAxis
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={(v: number) => formatMeasure(v, 'l', { digits: 1 })}
          />
          <Tooltip
            {...tooltipStyles}
            formatter={(value) =>
              typeof value === 'number'
                ? `${formatMeasure(value, 'l', { digits: 1 })}/head`
                : String(value)
            }
          />
          <Bar dataKey="perHead" name="Water per head" fill={chart.water} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
