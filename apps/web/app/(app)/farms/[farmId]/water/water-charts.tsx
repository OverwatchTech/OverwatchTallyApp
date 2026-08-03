'use client';

// Water consumption and trough temperature. Liquid measurement renders in
// water blue only (CLAUDE.md #4); multiple series stay inside the blue
// family. Values arrive SI (liters, °C) and convert at the tick/tooltip
// via formatMeasure.

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
import { chart, MONO_STACK } from '@/lib/ops/palette';

/** Water-family shades only — this is liquid measurement. */
const WATER_SHADES = ['#4FB3D9', '#2E7E9E', '#8FD0E8', '#1D5A73', '#B7E3F2'] as const;

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

export interface WaterBarRow {
  label: string;
  /** liters per head that day, keyed by pen name. */
  [penName: string]: string | number;
}

export function WaterPerHeadChart({ data, penNames }: { data: WaterBarRow[]; penNames: string[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid stroke={chart.grid} vertical={false} />
          <XAxis dataKey="label" tick={tickStyle} tickLine={false} axisLine={{ stroke: chart.grid }} />
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
          <Legend wrapperStyle={{ fontFamily: MONO_STACK, fontSize: 11, color: chart.tick }} iconSize={9} />
          {penNames.map((pen, i) => (
            <Bar key={pen} dataKey={pen} fill={WATER_SHADES[i % WATER_SHADES.length]} maxBarSize={22} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface TempTraceRow {
  /** epoch ms */
  t: number;
  /** °C keyed by trough name. */
  [troughName: string]: number;
}

export function TroughTempChart({
  data,
  troughNames,
  timezone,
}: {
  data: TempTraceRow[];
  troughNames: string[];
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
    <div className="h-56 w-full">
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
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            width={56}
            domain={['auto', 'auto']}
            tickFormatter={(v: number) => formatMeasure(v, 'c')}
          />
          <Tooltip
            {...tooltipStyles}
            labelFormatter={(t) => (typeof t === 'number' ? timeLabel(t) : String(t))}
            formatter={(value) =>
              typeof value === 'number' ? formatMeasure(value, 'c') : String(value)
            }
          />
          <Legend wrapperStyle={{ fontFamily: MONO_STACK, fontSize: 11, color: chart.tick }} iconSize={9} />
          {troughNames.map((name, i) => (
            <Line
              key={name}
              dataKey={name}
              stroke={WATER_SHADES[i % WATER_SHADES.length]}
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
