'use client';

// Telemetry Rail — the marketing site's signature made real. A fixed strip on
// the right edge (bottom bar on mobile) showing the four numbers that matter:
// latest trough reading, water today, head on feed, open alerts. Values
// update live over Supabase Realtime (postgres_changes, RLS-scoped through
// the session client — the anon key plus the member's JWT, never
// service_role). File name is internal vocabulary; the UI never says
// "telemetry" to a customer (CLAUDE.md #5).
//
// The readings table is partitioned by month and the realtime publication
// carries the partitions themselves, so we bind to the current and next
// month's partition tables and filter by farm.
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { formatMeasure } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/client';
import {
  fetchFarmVitals,
  fetchOpenAlertCount,
  fetchWaterTodayL,
  type FarmVitals,
} from '@/lib/dashboard/vitals';
import { formatClock } from '@/lib/dashboard/timezone';

const FARM_PATH = /^\/farms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/i;

/** readings partition table names for now and next month (UTC boundaries). */
function readingsPartitions(now: Date = new Date()): string[] {
  const stamp = (d: Date) =>
    `readings_${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return [...new Set([stamp(now), stamp(next)])];
}

interface RailState {
  vitals: FarmVitals | null;
  live: boolean;
  loaded: boolean;
}

export function TelemetryRail({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const farmId = pathname.match(FARM_PATH)?.[1] ?? null;

  // Quiet on every non-farm route: no strip, no layout impact.
  if (!farmId) return <>{children}</>;

  return (
    <>
      <div className="flex min-w-0 flex-1">
        <div className="min-w-0 flex-1 pb-14 md:pb-0">{children}</div>
        <RailStrip farmId={farmId} />
      </div>
    </>
  );
}

function RailStrip({ farmId }: { farmId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<RailState>({ vitals: null, live: false, loaded: false });
  const vitalsRef = useRef<FarmVitals | null>(null);
  vitalsRef.current = state.vitals;

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    setState({ vitals: null, live: false, loaded: false });

    const patch = (update: Partial<FarmVitals>) => {
      if (cancelled) return;
      setState((prev) =>
        prev.vitals ? { ...prev, vitals: { ...prev.vitals, ...update } } : prev,
      );
    };

    const debounce = (key: 'water' | 'alerts', run: () => void) => {
      // Coalesce bursts (a batched webhook fan-out) into one refetch.
      const t = setTimeout(run, key === 'water' ? 1500 : 400);
      timers.push(t);
    };

    fetchFarmVitals(supabase, farmId).then((vitals) => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, vitals, loaded: true }));
    });

    const channel = supabase.channel(`rail-${farmId}`);
    for (const table of readingsPartitions()) {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table, filter: `farm_id=eq.${farmId}` },
        (payload) => {
          const row = payload.new as {
            metric?: string;
            value?: number | null;
            device_id?: string;
            received_at?: string;
          };
          const vitals = vitalsRef.current;
          if (!vitals || !row.metric) return;
          if (
            row.metric === 'distance_mm' &&
            typeof row.value === 'number' &&
            row.device_id &&
            vitals.troughDeviceIds.includes(row.device_id)
          ) {
            patch({ trough: { distanceMm: row.value, at: row.received_at ?? '' } });
          }
          if (row.metric === 'pulse_count') {
            debounce('water', () => {
              fetchWaterTodayL(supabase, farmId, vitals.timezone).then((waterTodayL) =>
                patch({ waterTodayL }),
              );
            });
          }
        },
      );
    }
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'water_events', filter: `farm_id=eq.${farmId}` },
      () => {
        const vitals = vitalsRef.current;
        if (!vitals) return;
        debounce('water', () => {
          fetchWaterTodayL(supabase, farmId, vitals.timezone).then((waterTodayL) =>
            patch({ waterTodayL }),
          );
        });
      },
    );
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'alerts', filter: `farm_id=eq.${farmId}` },
      () => {
        debounce('alerts', () => {
          fetchOpenAlertCount(supabase, farmId).then((openAlerts) => patch({ openAlerts }));
        });
      },
    );
    channel.subscribe((status) => {
      if (cancelled) return;
      setState((prev) => ({ ...prev, live: status === 'SUBSCRIBED' }));
    });

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      supabase.removeChannel(channel);
    };
  }, [supabase, farmId]);

  const { vitals, live, loaded } = state;
  const tz = vitals?.timezone;

  const troughValue = vitals?.trough ? formatMeasure(vitals.trough.distanceMm, 'mm') : '—';
  const troughSub = vitals?.trough && tz ? formatClock(vitals.trough.at, tz) : loaded ? 'no sensor' : '';
  const waterValue =
    vitals?.waterTodayL !== null && vitals?.waterTodayL !== undefined
      ? formatMeasure(vitals.waterTodayL, 'l', { digits: 0 })
      : '—';
  const headValue =
    vitals?.headOnFeed !== null && vitals?.headOnFeed !== undefined
      ? vitals.headOnFeed.toLocaleString('en-US')
      : '—';
  const alertCount = vitals?.openAlerts ?? 0;
  const alertValue = loaded ? String(alertCount) : '—';

  const items = [
    {
      key: 'trough',
      label: 'Trough',
      value: troughValue,
      sub: troughSub,
      title: 'Latest trough sensor distance — closer is fuller. Uncalibrated.',
      tone: 'text-foreground',
    },
    {
      key: 'water',
      label: 'Water today',
      value: waterValue,
      sub: '',
      title: 'Metered water since midnight, farm time.',
      tone: 'text-water',
    },
    {
      key: 'head',
      label: 'Head on feed',
      value: headValue,
      sub: '',
      title: 'Head currently placed in pens and pastures.',
      tone: 'text-foreground',
    },
    {
      key: 'alerts',
      label: 'Alerts',
      value: alertValue,
      sub: '',
      title: 'Open alerts on this farm.',
      tone: alertCount > 0 ? 'text-alert' : 'text-muted',
    },
  ];

  return (
    <>
      {/* Desktop: right-edge strip. Fixed width; values never reflow it. */}
      <aside
        aria-label="Live farm numbers"
        className="hidden w-32 shrink-0 border-l border-hairline bg-background md:block"
      >
        <div className="sticky top-0 flex h-screen flex-col" aria-live="polite">
          <p className="flex items-center gap-1.5 border-b border-hairline px-3 py-3 text-[10px] tracking-wide text-muted uppercase">
            <span
              aria-hidden
              className={`inline-block h-1.5 w-1.5 rounded-full ${live ? 'bg-accent' : 'bg-faint'}`}
            />
            {live ? 'live' : 'linking'}
          </p>
          {items.map((item) => (
            <div key={item.key} className="border-b border-hairline px-3 py-4" title={item.title}>
              <p className="text-[10px] tracking-wide text-muted uppercase">{item.label}</p>
              <p
                key={item.value}
                className={`machine rail-swap mt-1 overflow-hidden text-lg whitespace-nowrap ${item.tone}`}
              >
                {item.value}
              </p>
              {item.sub ? <p className="machine mt-0.5 text-[10px] text-faint">{item.sub}</p> : null}
            </div>
          ))}
          <p className="mt-auto px-3 py-3 text-[10px] leading-snug text-faint">
            Trough shows sensor distance — closer is fuller. Uncalibrated.
          </p>
        </div>
      </aside>

      {/* Mobile: bottom bar, same four numbers. */}
      <nav
        aria-label="Live farm numbers"
        aria-live="polite"
        className="fixed inset-x-0 bottom-0 z-40 grid h-14 grid-cols-4 border-t border-hairline bg-background md:hidden"
      >
        {items.map((item) => (
          <div
            key={item.key}
            title={item.title}
            className="flex flex-col items-center justify-center gap-0.5 border-r border-hairline px-1 last:border-r-0"
          >
            <span className="text-[9px] tracking-wide text-muted uppercase">{item.label}</span>
            <span
              key={item.value}
              className={`machine rail-swap overflow-hidden text-xs whitespace-nowrap ${item.tone}`}
            >
              {item.value}
            </span>
          </div>
        ))}
      </nav>
    </>
  );
}
