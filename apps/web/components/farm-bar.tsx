'use client';

// The 54px bar's live pieces (docs/reference/portal-mockup.html, `.bar`).
//
// The bar is farm-scoped but `app/(app)/layout.tsx` sits above the [farmId]
// segment and never sees the param, so the current farm is read from the
// pathname here — the same trick the Telemetry Rail used. Everything the
// server knows (the farm list, the open-alert counts, who is signed in)
// arrives as props; nothing is re-derived.
//
// LOCAL ON PURPOSE. Three of these — the farm menu, the account menu, the
// clock — are not in packages/ui, and four agents are converting screens
// against that package right now. They live here so the coordinator can
// promote them later without a race. The triggers reuse the `ow-farmpicker`
// class from globals.css; the popup reuses the drawer's own overlay values
// rather than inventing a new surface.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FocusEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertPill, Stat, StatusDot, TabPills, type TabPillItem } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/client';
import { fetchOpenAlertCount } from '@/lib/dashboard/vitals';
import { formatClock } from '@/lib/dashboard/timezone';

export interface BarFarm {
  id: string;
  name: string;
  timezone: string;
}

const FARM_PATH =
  /^\/farms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\/|$)/i;

/**
 * The farm the bar is describing: the one in the URL, or the only one the
 * account holds. Null for a multi-farm account standing on a route that is
 * not inside a farm — the tabs have nothing to point at, so they hide.
 */
function useCurrentFarm(farms: readonly BarFarm[]): BarFarm | null {
  const pathname = usePathname();
  const id = pathname.match(FARM_PATH)?.[1]?.toLowerCase() ?? null;
  if (id !== null) return farms.find((f) => f.id.toLowerCase() === id) ?? null;
  return farms.length === 1 ? (farms[0] ?? null) : null;
}

/** The section slug under /farms/<id>: '' for the overview, null when off-farm. */
function useSection(farm: BarFarm | null): string | null {
  const pathname = usePathname();
  if (farm === null) return null;
  const base = `/farms/${farm.id}`;
  if (!pathname.toLowerCase().startsWith(base.toLowerCase())) return null;
  return pathname.slice(base.length).split('/')[1] ?? '';
}

/* ── tabs ───────────────────────────────────────────────────────────── */

/**
 * The owner's four tabs, scoped to the farm in view. map/boundary/import all
 * light Site Map and feed/forecast both light Feed & Forecast, because those
 * routes are one place to a rancher even though they are separate URLs.
 */
export function FarmTabs({ farms }: { farms: readonly BarFarm[] }) {
  const farm = useCurrentFarm(farms);
  const section = useSection(farm);
  if (farm === null) return null;

  const base = `/farms/${farm.id}`;
  const items: TabPillItem[] = [
    { label: 'Overview', href: base, active: section === '' },
    {
      label: 'Site Map',
      href: `${base}/map`,
      active: section === 'map' || section === 'boundary' || section === 'import',
    },
    {
      label: 'Feed & Forecast',
      href: `${base}/feed`,
      active: section === 'feed' || section === 'forecast',
    },
    { label: 'Water', href: `${base}/water`, active: section === 'water' },
  ];
  return <TabPills items={items} linkAs={Link} label="Farm sections" />;
}

/* ── the dropdown both menus share ──────────────────────────────────── */

const POPUP: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  minWidth: '210px',
  maxWidth: '280px',
  background: 'var(--panel)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  border: '1px solid var(--line2)',
  borderRadius: '12px',
  boxShadow: '0 16px 50px rgba(0,0,0,.55)',
  padding: '5px',
  zIndex: 60,
};

const TRIGGER: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  borderRadius: 9,
};

const ITEM: CSSProperties = {
  display: 'block',
  padding: '7px 10px',
  borderRadius: '8px',
  fontSize: '12.5px',
  fontWeight: 600,
  color: 'var(--ink2)',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  width: '100%',
  textAlign: 'left',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
};

const MENU_LABEL: CSSProperties = {
  padding: '6px 10px 4px',
  fontSize: '10.5px',
  letterSpacing: '.08em',
  textTransform: 'uppercase',
  color: 'var(--ink3)',
  fontWeight: 700,
};

interface MenuProps {
  label: string;
  /** The face of the trigger. The <button> around it belongs to this component. */
  trigger: ReactNode;
  align?: 'left' | 'right';
  children: ReactNode;
}

/**
 * A menu button with roving arrow-key focus, Home/End, Escape-back-to-trigger,
 * and click-outside. The items are real links, so Tab order and a screen
 * reader's link list both still work — the arrow keys are an addition, not the
 * only way in.
 */
function Menu({ label, trigger, align = 'left', children }: MenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Route changed — the menu did its job.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const items = useCallback(
    () => Array.from(popupRef.current?.querySelectorAll<HTMLElement>('[data-mi]') ?? []),
    [],
  );

  const focusAt = useCallback(
    (index: number) => {
      const list = items();
      if (list.length === 0) return;
      const wrapped = ((index % list.length) + list.length) % list.length;
      list[wrapped]?.focus();
    },
    [items],
  );

  // Opening with a key lands on an item; opening with the mouse does not
  // steal focus out from under the pointer. setTimeout, not rAF: a background
  // or non-composited tab can withhold animation frames indefinitely, and the
  // keyboard path must not depend on the tab being painted.
  const openWith = (index: number | null) => {
    setOpen(true);
    if (index !== null) setTimeout(() => focusAt(index), 0);
  };

  const onTriggerKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openWith(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openWith(-1);
    }
  };

  const onPopupKeyDown = (e: KeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusAt(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusAt(at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusAt(list.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'flex' }}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => (open ? setOpen(false) : openWith(null))}
        onKeyDown={onTriggerKeyDown}
        style={TRIGGER}
      >
        {trigger}
      </button>
      {open ? (
        <div
          ref={popupRef}
          role="menu"
          aria-label={label}
          onKeyDown={onPopupKeyDown}
          style={{ ...POPUP, ...(align === 'right' ? { right: 0 } : { left: 0 }) }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  href,
  children,
  current,
}: {
  href?: string;
  children: ReactNode;
  /** The farm already in view. Carried by aria-current too, not colour alone. */
  current?: boolean;
}) {
  const hover = (e: MouseEvent | FocusEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.style.background = 'rgba(255,255,255,.06)';
    el.style.color = 'var(--ink)';
  };
  const rest = (e: MouseEvent | FocusEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.style.background = 'none';
    el.style.color = current === true ? 'var(--ok)' : 'var(--ink2)';
  };

  if (href !== undefined) {
    return (
      <Link
        href={href}
        role="menuitem"
        data-mi=""
        aria-current={current === true ? 'page' : undefined}
        style={current === true ? { ...ITEM, color: 'var(--ok)' } : ITEM}
        onMouseEnter={hover}
        onMouseLeave={rest}
        onFocus={hover}
        onBlur={rest}
      >
        {children}
      </Link>
    );
  }
  return (
    <button
      type="submit"
      role="menuitem"
      data-mi=""
      style={ITEM}
      onMouseEnter={hover}
      onMouseLeave={rest}
      onFocus={hover}
      onBlur={rest}
    >
      {children}
    </button>
  );
}

/* ── farm picker ────────────────────────────────────────────────────── */

/**
 * Compact farm switcher, beside the brand mark. Rendered ONLY when the account
 * holds more than one farm — a single-farm operation is meant to see the bar
 * exactly as the mockup draws it.
 */
export function FarmPickerMenu({ farms }: { farms: readonly BarFarm[] }) {
  const current = useCurrentFarm(farms);
  if (farms.length < 2) return null;

  return (
    <Menu
      label="Switch farm"
      trigger={<FarmPickerFace name={current?.name ?? 'Choose a farm'} />}
    >
      <>
        <div style={MENU_LABEL}>Your farms</div>
        {farms.map((farm) => (
          <MenuItem key={farm.id} href={`/farms/${farm.id}`} current={farm.id === current?.id}>
            {farm.name}
          </MenuItem>
        ))}
      </>
    </Menu>
  );
}

function FarmPickerFace({ name }: { name: string }) {
  return (
    <span className="ow-farmpicker">
      <span className="nm">{name}</span>
      <span className="cv" aria-hidden="true">
        &#9660;
      </span>
    </span>
  );
}

/* ── right-hand chrome: alerts, live status, clock, account ─────────── */

export interface BarStatusProps {
  farms: readonly BarFarm[];
  /** Open alerts per farm id, counted on the server. */
  alertCounts: Record<string, number>;
  email: string;
  canManage: boolean;
  isStaff: boolean;
  signOutAction: () => Promise<void>;
}

export function BarStatus({
  farms,
  alertCounts,
  email,
  canManage,
  isStaff,
  signOutAction,
}: BarStatusProps) {
  const farm = useCurrentFarm(farms);
  const serverCount = farm
    ? (alertCounts[farm.id] ?? 0)
    : Object.values(alertCounts).reduce((a, b) => a + b, 0);

  const { count, live } = useLiveAlerts(farm?.id ?? null, serverCount);

  return (
    <>
      <AlertPill count={count} href="/alerts" />
      {/* Only where there is something to keep live. Off-farm there is no
          channel open, and "linking" would be describing a connection this
          screen never tried to make. */}
      {farm !== null ? (
        <Stat>
          <StatusDot
            glow={live}
            tone={live ? 'ok' : 'off'}
            label={live ? 'Updating live' : 'Reconnecting to live updates'}
          />
          Updates <b>{live ? 'live' : 'linking'}</b>
        </Stat>
      ) : null}
      <Clock timezone={farm?.timezone ?? null} />
      <AccountMenu
        email={email}
        canManage={canManage}
        isStaff={isStaff}
        signOutAction={signOutAction}
      />
    </>
  );
}

/**
 * The open-alert count, kept current. The server rendered a count; this
 * re-reads it whenever an alert row changes, so the pill does not go stale on
 * a screen left open on a shop monitor all day. `live` is the subscription's
 * own state — it says the connection is up, and claims nothing more.
 */
function useLiveAlerts(farmId: string | null, initial: number) {
  const supabase = useMemo(() => createClient(), []);
  const [count, setCount] = useState(initial);
  const [live, setLive] = useState(false);

  useEffect(() => {
    setCount(initial);
  }, [initial]);

  useEffect(() => {
    if (farmId === null) {
      setLive(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const channel = supabase.channel(`bar-alerts-${farmId}`);
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'alerts', filter: `farm_id=eq.${farmId}` },
      () => {
        // Coalesce a batched fan-out into one refetch.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void fetchOpenAlertCount(supabase, farmId).then((n) => {
            if (!cancelled) setCount(n);
          });
        }, 400);
      },
    );
    void channel.subscribe((status) => {
      if (!cancelled) setLive(status === 'SUBSCRIBED');
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, farmId]);

  return { count, live };
}

/**
 * Farm-local clock. Renders nothing until mounted: the server's idea of "now"
 * and the browser's are never the same millisecond, and that is a hydration
 * error, not a rounding difference.
 */
function Clock({ timezone }: { timezone: string | null }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);

  if (now === null || timezone === null) return null;
  return (
    <Stat>
      <b>{formatClock(now, timezone)}</b>
    </Stat>
  );
}

/**
 * Everything the old sidebar carried that the mockup's bar has no slot for:
 * who is signed in, alerts, settings, the staff console, sign out. The bar
 * replaced the sidebar; it did not get to drop the sidebar's routes.
 */
function AccountMenu({
  email,
  canManage,
  isStaff,
  signOutAction,
}: {
  email: string;
  canManage: boolean;
  isStaff: boolean;
  signOutAction: () => Promise<void>;
}) {
  const initial = email.trim().charAt(0).toUpperCase() || '?';
  return (
    <Menu
      label="Account and settings"
      align="right"
      trigger={<AccountFace initial={initial} />}
    >
      <>
        <div
          style={{
            padding: '6px 10px',
            fontSize: '11px',
            color: 'var(--ink3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {email}
        </div>
        <MenuItem href="/alerts">Alerts</MenuItem>
        {canManage ? <MenuItem href="/settings/members">Settings</MenuItem> : null}
        {isStaff ? <MenuItem href="/admin">Operations</MenuItem> : null}
        <div style={{ height: 1, background: 'var(--line)', margin: '5px 4px' }} />
        <form action={signOutAction}>
          <MenuItem>Sign out</MenuItem>
        </form>
      </>
    </Menu>
  );
}

function AccountFace({ initial }: { initial: string }) {
  return (
    <span
      className="ow-farmpicker"
      style={{
        width: 28,
        height: 28,
        minWidth: 28,
        padding: 0,
        borderRadius: 8,
        justifyContent: 'center',
        color: 'var(--ink)',
      }}
    >
      {initial}
    </span>
  );
}
