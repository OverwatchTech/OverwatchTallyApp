'use client';

// The Water tab's live trough tiles, and the sentence the Telemetry Rail used
// to carry: "Trough shows sensor distance — closer is fuller. Uncalibrated."
// It leads the dashed note under the grid, verbatim, because it is the whole
// reason the number is safe to show at all.
//
// Live the way the rail was live: Supabase Realtime `postgres_changes` over
// the session client — the anon key plus the member's JWT, RLS-scoped, never
// service_role. `readings` is range-partitioned by month and the publication
// carries the partitions themselves, so this binds the current and the next
// month's partition table and filters on farm.
//
// Nothing here is called telemetry, a device, a sensor id or an uplink in
// front of a customer (CLAUDE.md #5) — the tiles say troughs and pens.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Card,
  Legend,
  LegendSwatch,
  StatusDot,
  Tile,
  TileGrid,
  formatMeasure,
} from '@overwatch/ui';
import { createClient } from '@/lib/supabase/client';
import {
  WARN_BAND,
  troughTiles,
  type TroughLimits,
  type TroughMetric,
  type TroughSensor,
} from './trough-levels';

export interface TroughLevelsLiveProps {
  farmId: string;
  sensors: TroughSensor[];
  limits: TroughLimits;
  alertedDeviceIds: string[];
  /** Server render instant — the client starts its clock here, not at hydration. */
  renderedAt: string;
}

/** `readings` partition tables for this month and next (UTC boundaries). */
function readingsPartitions(now: Date = new Date()): string[] {
  const stamp = (d: Date) =>
    `readings_${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [...new Set([stamp(now), stamp(next)])];
}

/** Re-check staleness on this cadence; a quiet trough goes grey on its own. */
const TICK_MS = 60_000;

export function TroughLevelsLive({
  farmId,
  sensors: initialSensors,
  limits,
  alertedDeviceIds: initialAlerted,
  renderedAt,
}: TroughLevelsLiveProps) {
  const supabase = useMemo(() => createClient(), []);
  const [sensors, setSensors] = useState(initialSensors);
  const [alerted, setAlerted] = useState<string[]>(initialAlerted);
  const [live, setLive] = useState(false);
  // Starts on the server's clock so the first client render matches the HTML
  // that arrived; the tick below takes over from there.
  const [nowMs, setNowMs] = useState(() => {
    const t = Date.parse(renderedAt);
    return Number.isFinite(t) ? t : Date.now();
  });

  // Memoise on a primitive, not on the props array: a re-render hands back a
  // fresh array identity, and a Set that changes identity every render would
  // tear the channel down and rebuild it in a loop.
  const deviceKey = initialSensors.map((s) => s.deviceId).join(',');
  const deviceIds = useMemo(
    () => new Set(deviceKey.split(',').filter(Boolean)),
    [deviceKey],
  );

  const refetchAlerts = useCallback(async () => {
    const { data } = await supabase
      .from('alerts')
      .select('details')
      .eq('farm_id', farmId)
      .eq('kind', 'trough_low')
      .is('resolved_at', null);
    if (!data) return;
    const ids = data
      .map((row) => {
        const d = row.details;
        if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
        const id = (d as Record<string, unknown>).device_id;
        return typeof id === 'string' ? id : null;
      })
      .filter((id): id is string => id !== null);
    setAlerted([...new Set(ids)]);
  }, [supabase, farmId]);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const alertsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const timer = alertsTimer;

    const channel = supabase.channel(`troughs-${farmId}`);
    for (const table of readingsPartitions()) {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table, filter: `farm_id=eq.${farmId}` },
        (payload) => {
          const row = payload.new as {
            device_id?: string;
            metric?: string;
            value?: number | null;
            received_at?: string;
          };
          if (!row.device_id || !deviceIds.has(row.device_id)) return;
          if (row.metric !== 'distance_mm' && row.metric !== 'level_mm') return;
          if (typeof row.value !== 'number' || !row.received_at) return;
          const metric = row.metric as TroughMetric;
          const mm = row.value;
          const at = row.received_at;
          setNowMs(Date.now());
          setSensors((prev) =>
            prev.map((s) =>
              s.deviceId === row.device_id
                ? // Out-of-order delivery must not walk the reading backwards.
                  s.at !== null && new Date(s.at).getTime() > new Date(at).getTime()
                  ? s
                  : { ...s, metric, mm, at }
                : s,
            ),
          );
        },
      );
    }
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'alerts', filter: `farm_id=eq.${farmId}` },
      () => {
        // Coalesce a batched open/resolve fan-out into one read. One timer,
        // replaced each time, so a long-lived page does not accumulate them.
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void refetchAlerts(), 400);
      },
    );
    channel.subscribe((status) => {
      if (!cancelled) setLive(status === 'SUBSCRIBED');
    });

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      void supabase.removeChannel(channel);
    };
  }, [supabase, farmId, deviceIds, refetchAlerts]);

  const alertedSet = useMemo(() => new Set(alerted), [alerted]);
  const tiles = troughTiles(sensors, limits, alertedSet, nowMs);
  const quietHours = Math.round(limits.staleMinutes / 60);
  const depthCount = tiles.filter((t) => t.metric === 'level_mm').length;
  const emptyLine = formatMeasure(limits.maxDistanceMm, 'mm');

  return (
    <Card
      title="Trough levels"
      sub={
        <>
          <StatusDot
            tone={live ? 'ok' : 'off'}
            label={live ? 'Readings are updating live' : 'Connecting to live readings'}
          />{' '}
          {live ? 'live' : 'linking'} · {tiles.length} trough
          {tiles.length === 1 ? '' : 's'}
        </>
      }
      aside={
        <Legend>
          <LegendSwatch tone="ok">reporting</LegendSwatch>
          <LegendSwatch tone="warn">near the empty line</LegendSwatch>
          <LegendSwatch tone="crit">past it</LegendSwatch>
          <LegendSwatch tone="sel">up at the sensor</LegendSwatch>
          <LegendSwatch tone="off">quiet {quietHours} h</LegendSwatch>
        </Legend>
      }
      padded={false}
      note={
        <>
          {/* The dashed note runs at --ink3, which clears 3.1:1 on the card.
              That is fine for the qualifiers around it and not fine for the
              one sentence that keeps the number honest, so the caveat itself
              is lifted to --ink2 (measured 7.0:1) and leads the note. */}
          <b style={{ color: 'var(--ink2)' }}>
            Trough shows sensor distance — closer is fuller. Uncalibrated.
          </b>{' '}
          {limits.ruleOn ? (
            <>
              The bar runs from the empty line this operation set on its own low-water rule
              ({emptyLine} down) up to the sensor itself. <b>It is not a fill level</b> — turning
              a distance into gallons or a percent needs the trough measured and a calibration
              on file for that sensor, and this farm has neither. Red is the reading past that
              line, or an open low-water alert on that trough. Amber and blue are a{' '}
              <b>display band</b> — the last {Math.round(WARN_BAND * 100)}% at either end, a
              heads-up on the walk out, never a finding and never an alert. A reading right up
              at the sensor is as easily a fouled sensor as a float stuck open, so the tile says
              where the water is and leaves the diagnosis to whoever opens the lid.
            </>
          ) : (
            <>
              This farm has no low-water rule turned on, so there is no line to colour these
              against and no scale to draw a bar from. The tiles carry the raw reading and
              nothing more.
            </>
          )}{' '}
          A trough silent for more than {quietHours} h greys out: no reading is not the same as
          an empty trough.
          {depthCount > 0 ? (
            <>
              {' '}
              {depthCount === 1 ? 'One trough here is' : `${depthCount} troughs here are`} read by
              a sensor sitting <i>in</i> the water, which reports depth over itself — the
              opposite direction. {depthCount === 1 ? 'Its tile is' : 'Those tiles are'} marked{' '}
              <b>depth</b> and {depthCount === 1 ? 'carries' : 'carry'} no bar, because nothing on
              file says how deep full is.
            </>
          ) : null}
        </>
      }
    >
      {tiles.length > 0 ? (
        <TileGrid>
          {tiles.map((t) => (
            <Tile
              key={t.deviceId}
              id={t.name}
              aside={
                t.metric === 'level_mm' ? (
                  <span style={{ fontSize: '9px', color: 'var(--ink3)' }}>depth</span>
                ) : undefined
              }
              value={t.value}
              state={t.state}
              fillPct={t.fillPct}
              title={t.title}
            />
          ))}
        </TileGrid>
      ) : (
        <div className="ow-note">No trough sensor is reporting on this farm yet.</div>
      )}
    </Card>
  );
}
