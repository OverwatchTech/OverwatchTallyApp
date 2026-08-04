'use client';

// Open support session, with the clock running down.
//
// The countdown is cosmetic. Expiry is decided server-side on every audited
// call by comparing impersonation_expires_at to now(); when this hits zero the
// grant is already dead whether or not the tab was ever refreshed. The banner
// is alert-colored because an open cross-tenant session IS something being
// wrong-until-closed (CLAUDE.md #4) — it is not decoration.
//
// It sticks to the top of the view rather than sitting above the bar: the
// shell is a fixed 54px + 100vh grid and the page itself never scrolls, so a
// strip outside it would be clipped rather than shown.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { endSupportSession } from './actions';

export function SessionBanner({
  orgName,
  reason,
  expiresAt,
}: {
  orgName: string;
  reason: string;
  expiresAt: string;
}) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(() => msLeft(expiresAt));

  useEffect(() => {
    const tick = () => {
      const left = msLeft(expiresAt);
      setRemaining(left);
      // Once it lapses, re-render from the server so every gated surface
      // re-evaluates against the same expiry the database will enforce.
      if (left <= 0) router.refresh();
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, router]);

  const expired = remaining <= 0;

  return (
    <div role="status" className="ow-banner sticky">
      <span>
        Support session on <b>{orgName}</b>
      </span>
      <span className="m">{reason}</span>
      <span className="m push" style={{ color: 'var(--ink)' }}>
        {expired ? 'expired' : `${formatClock(remaining)} left`}
      </span>
      <form action={endSupportSession}>
        <button type="submit" className="ow-btn sm">
          End session
        </button>
      </form>
    </div>
  );
}

function msLeft(expiresAt: string): number {
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
