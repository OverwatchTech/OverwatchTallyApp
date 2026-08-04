// The quiet-hours timeline, driven by an injected clock.
//
// WHAT THIS FILE IS FOR. `alert-dispatch` is not deployed and every seeded
// rule has `quiet_hours = NULL`, so the defect this covers is invisible to
// every other check: it tests clean today and keeps testing clean until the
// first customer sets a quiet window, at which point the failure mode is
// silence — the one failure nobody gets paged about. The only honest way to
// prove the fix without spending a real text message is to replay the
// timeline against the pure decision functions.
//
// THE TIMELINE. A farm in America/Denver. Quiet hours 21:00–05:00. An alert
// opens at 02:00 farm-local. The evaluator runs every five minutes. Nobody
// acknowledges. Nothing may reach a phone before 05:00, something must reach
// one at 05:00, and the retry budget must survive the night.
//
// Run it: see README §verify.

import { describe, expect, it } from 'vitest';

import {
  HELD_QUIET_HOURS,
  MAX_ATTEMPTS_PER_RECIPIENT,
  alreadyHeld,
  alreadySettled,
  attemptsFor,
  dueTiers,
  escalationAnchor,
  inClockWindow,
  isSilenced,
  localMinutes,
  parseQuietHours,
  planDispatch,
} from './schedule.ts';
import type { DeliveryReceipt, QueuedAlert, Recipient, Severity } from './types.ts';

// ── Fixtures ────────────────────────────────────────────────────

const DENVER = 'America/Denver';

/** August, so Denver is MDT = UTC−6. 02:00 local is 08:00Z. */
const OPENED_AT = '2026-08-10T08:00:00.000Z';
/** 05:00 local — the first instant the window is shut behind us. */
const WINDOW_ENDS = Date.parse('2026-08-10T11:00:00.000Z');

const QUIET_21_TO_05 = { from: '21:00', to: '05:00', severities: ['info', 'warn'] };

/** Tier 0 now, tier 1 after 15 minutes, tier 2 after 45. */
const CHAIN = { tiers: [{ after_minutes: 0 }, { after_minutes: 15 }, { after_minutes: 45 }] };

const RANCH_CELL: Recipient = {
  id: 'r0',
  label: 'Ranch cell',
  channel: 'sms',
  address: '+15555550123',
  tier: 0,
};
const OFFICE_MAIL: Recipient = {
  id: 'r0b',
  label: 'Office',
  channel: 'email',
  address: 'office@example.com',
  tier: 0,
};
const SECOND_HAND: Recipient = {
  id: 'r1',
  label: 'Second hand',
  channel: 'sms',
  address: '+15555550124',
  tier: 1,
};
const OWNER_CELL: Recipient = {
  id: 'r2',
  label: 'Owner',
  channel: 'sms',
  address: '+15555550125',
  tier: 2,
};

function alertFixture(over: Partial<QueuedAlert> = {}): QueuedAlert {
  return {
    alert_id: 'a1',
    org_id: 'o1',
    farm_id: 'f1',
    farm_name: 'Farm Project',
    farm_timezone: DENVER,
    kind: 'trough_low',
    severity: 'warn' as Severity,
    opened_at: OPENED_AT,
    acknowledged_at: null,
    dedup_key: 'k',
    details: {},
    // The rules engine stamps this in the same INSERT that opens the alert.
    deliveries: [{ channel: 'in_app', status: 'delivered', tier: 0, at: OPENED_AT }],
    staff_only: false,
    quiet_hours: QUIET_21_TO_05,
    escalation: CHAIN,
    recipients: [RANCH_CELL, SECOND_HAND, OWNER_CELL],
    ...over,
  };
}

// ── The evaluator, simulated ────────────────────────────────────

interface RunRecord {
  at: string;
  localHHMM: string;
  wrote: DeliveryReceipt[];
}

/**
 * Replay the 5-minute scheduler over a window, appending receipts to the
 * alert exactly as `alert_dispatch_record` would (append-only, never rewrite).
 * A planned `send` is recorded as `sent`: the providers are mocked out by not
 * existing, which is the point — no credentials are invented here.
 */
function replay(alert: QueuedAlert, fromISO: string, toISO: string): RunRecord[] {
  const runs: RunRecord[] = [];
  const end = Date.parse(toISO);
  for (let t = Date.parse(fromISO); t <= end; t += 5 * 60_000) {
    const now = new Date(t);
    const plan = planDispatch(alert, now);
    const wrote: DeliveryReceipt[] = plan.map((step) => ({
      channel: step.recipient.channel,
      status: step.action === 'hold' ? HELD_QUIET_HOURS : 'sent',
      tier: step.tier,
      at: now.toISOString(),
      recipient_id: step.recipient.id,
      recipient_label: step.recipient.label,
    }));
    // The database appends; so do we.
    alert.deliveries = [...alert.deliveries, ...wrote];
    const min = localMinutes(now, alert.farm_timezone) ?? 0;
    runs.push({
      at: now.toISOString(),
      localHHMM: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
      wrote,
    });
  }
  return runs;
}

const sends = (runs: RunRecord[]) => runs.flatMap((r) => r.wrote.filter((w) => w.status === 'sent'));
const holds = (runs: RunRecord[]) =>
  runs.flatMap((r) => r.wrote.filter((w) => w.status === HELD_QUIET_HOURS));

// ── Timezone: verified, not trusted ─────────────────────────────

describe('quiet hours evaluate in the FARM timezone', () => {
  it('reads 02:00 in Denver for the instant the alert opened', () => {
    expect(localMinutes(new Date(OPENED_AT), DENVER)).toBe(2 * 60);
  });

  it('reads the same instant as 08:00 in UTC — the server clock is not the farm clock', () => {
    expect(localMinutes(new Date(OPENED_AT), 'UTC')).toBe(8 * 60);
  });

  it('holds the Denver farm and does not hold a UTC farm at the same instant', () => {
    const now = new Date(OPENED_AT);
    expect(isSilenced(alertFixture(), now)).toBe(true);
    expect(isSilenced(alertFixture({ farm_timezone: 'UTC' }), now)).toBe(false);
  });

  it('treats an unknown zone as no quiet hours rather than silencing', () => {
    expect(localMinutes(new Date(OPENED_AT), 'Mars/Olympus')).toBeNull();
    expect(isSilenced(alertFixture({ farm_timezone: 'Mars/Olympus' }), new Date(OPENED_AT))).toBe(
      false,
    );
  });

  it('wraps a window across midnight', () => {
    expect(inClockWindow(2 * 60, 21 * 60, 5 * 60)).toBe(true);
    expect(inClockWindow(23 * 60, 21 * 60, 5 * 60)).toBe(true);
    expect(inClockWindow(12 * 60, 21 * 60, 5 * 60)).toBe(false);
    expect(inClockWindow(5 * 60, 21 * 60, 5 * 60)).toBe(false);
  });
});

// ── The defect, and the fix ─────────────────────────────────────

describe('an alert opened at 02:00 inside a 21:00-05:00 window', () => {
  it('reaches nobody before 05:00, holds exactly once, then calls at 05:00', () => {
    const alert = alertFixture();
    // 02:00 local through 06:00 local.
    const runs = replay(alert, OPENED_AT, '2026-08-10T12:00:00.000Z');

    const beforeWindowEnds = runs.filter((r) => Date.parse(r.at) < WINDOW_ENDS);
    expect(sends(beforeWindowEnds)).toEqual([]);

    // THE FLOOD GUARD: one held receipt for the night, not one per five
    // minutes. 36 runs happen before the window ends.
    expect(beforeWindowEnds.length).toBe(36);
    const held = holds(runs);
    expect(held.length).toBe(1);
    expect(held[0]?.recipient_id).toBe(RANCH_CELL.id);
    expect(held[0]?.at).toBe(OPENED_AT);

    // THE FIX: a real attempt on the first run after the window ends.
    const firstSend = sends(runs)[0];
    expect(firstSend?.at).toBe(new Date(WINDOW_ENDS).toISOString());
    expect(firstSend?.recipient_id).toBe(RANCH_CELL.id);
    expect(firstSend?.tier).toBe(0);
  });

  it('does not spend the retry budget on holding', () => {
    const alert = alertFixture();
    // Stop one run short of the window ending: the whole night, no send.
    replay(alert, OPENED_AT, '2026-08-10T10:55:00.000Z');

    expect(attemptsFor(alert.deliveries, 0, RANCH_CELL.id)).toBe(0);
    expect(attemptsFor(alert.deliveries, 0, RANCH_CELL.id)).toBeLessThan(
      MAX_ATTEMPTS_PER_RECIPIENT,
    );
    expect(alreadyHeld(alert.deliveries, 0, RANCH_CELL.id)).toBe(true);
    // A hold is not an outcome. This is the assertion the old code failed.
    expect(alreadySettled(alert.deliveries, 0, RANCH_CELL.id)).toBe(false);
  });

  it('leaves a delivery log that reads as a history: opened, held, called', () => {
    const alert = alertFixture();
    replay(alert, OPENED_AT, '2026-08-10T11:05:00.000Z');
    expect(alert.deliveries.map((d) => `${d.at} ${d.channel} ${d.status}`)).toEqual([
      '2026-08-10T08:00:00.000Z in_app delivered',
      '2026-08-10T08:00:00.000Z sms suppressed_quiet_hours',
      '2026-08-10T11:00:00.000Z sms sent',
    ]);
  });

  it('escalates on the configured spacing after release, not all at once', () => {
    const alert = alertFixture();
    const runs = replay(alert, OPENED_AT, '2026-08-10T12:00:00.000Z');

    // Not one text per tier simultaneously: at most one tier per run.
    for (const run of runs) {
      expect(new Set(run.wrote.map((w) => w.tier)).size).toBeLessThanOrEqual(1);
    }

    expect(
      sends(runs).map((s) => `${s.at} tier ${s.tier} -> ${s.recipient_id ?? ''}`),
    ).toEqual([
      '2026-08-10T11:00:00.000Z tier 0 -> r0', // release: first person, first
      '2026-08-10T11:15:00.000Z tier 1 -> r1', // +15 min, as configured
      '2026-08-10T11:45:00.000Z tier 2 -> r2', // +45 min, as configured
    ]);
  });

  it('anchors the chain to the first real call, not to a 02:00 nobody heard', () => {
    const alert = alertFixture();
    // Anchor is opened_at while nothing has been attempted...
    expect(escalationAnchor(alert)).toBe(Date.parse(OPENED_AT));
    // ...and holding does not move it, because a hold is not an attempt.
    replay(alert, OPENED_AT, '2026-08-10T10:55:00.000Z');
    expect(escalationAnchor(alert)).toBe(Date.parse(OPENED_AT));
    // Once the call is placed, the chain runs from the call.
    replay(alert, '2026-08-10T11:00:00.000Z', '2026-08-10T11:00:00.000Z');
    expect(escalationAnchor(alert)).toBe(WINDOW_ENDS);
  });

  it('reaches every recipient on the released tier, both rails', () => {
    const alert = alertFixture({ recipients: [RANCH_CELL, OFFICE_MAIL, SECOND_HAND] });
    const runs = replay(alert, OPENED_AT, '2026-08-10T11:00:00.000Z');
    expect(holds(runs).map((h) => h.recipient_id)).toEqual(['r0', 'r0b']);
    expect(sends(runs).map((s) => `${s.channel}:${s.recipient_id ?? ''}`)).toEqual([
      'sms:r0',
      'email:r0b',
    ]);
  });
});

// ── Acknowledgement ─────────────────────────────────────────────

describe('acknowledgement', () => {
  it('acknowledged at 03:00 means no call at 05:00', () => {
    const alert = alertFixture({ acknowledged_at: '2026-08-10T09:00:00.000Z' });
    // The evaluator does not retro-edit: replay the night with the ack
    // already in place from 03:00 by splitting the timeline.
    const before = replay(alertFixture(), OPENED_AT, '2026-08-10T08:55:00.000Z');
    expect(sends(before)).toEqual([]);

    alert.deliveries = [...alert.deliveries, ...before.flatMap((r) => r.wrote)];
    const after = replay(alert, '2026-08-10T09:00:00.000Z', '2026-08-10T12:00:00.000Z');

    expect(sends(after)).toEqual([]);
    expect(holds(after)).toEqual([]);
    expect(dueTiers(alert, new Date(WINDOW_ENDS))).toEqual([]);
  });
});

// ── Severity escape hatch ───────────────────────────────────────

describe('critical is not silenceable', () => {
  it('ignores a customer-supplied severities list that ticks critical', () => {
    const quiet = parseQuietHours({
      from: '21:00',
      to: '05:00',
      severities: ['info', 'warn', 'critical'],
    });
    expect(quiet?.severities).toEqual(['info', 'warn']);
  });

  it('calls at 02:00 for a critical alert inside the window', () => {
    const alert = alertFixture({
      severity: 'critical',
      quiet_hours: { from: '21:00', to: '05:00', severities: ['info', 'warn', 'critical'] },
    });
    expect(isSilenced(alert, new Date(OPENED_AT))).toBe(false);
    const runs = replay(alert, OPENED_AT, OPENED_AT);
    expect(holds(runs)).toEqual([]);
    expect(sends(runs).map((s) => s.recipient_id)).toEqual(['r0']);
  });

  it('still holds info and warn', () => {
    expect(isSilenced(alertFixture({ severity: 'info' }), new Date(OPENED_AT))).toBe(true);
    expect(isSilenced(alertFixture({ severity: 'warn' }), new Date(OPENED_AT))).toBe(true);
  });

  it('a window listing only critical silences nothing', () => {
    const alert = alertFixture({
      quiet_hours: { from: '21:00', to: '05:00', severities: ['critical'] },
    });
    expect(isSilenced(alert, new Date(OPENED_AT))).toBe(false);
  });
});

// ── Regressions the fix must not cause ──────────────────────────

describe('behaviour outside quiet hours is unchanged', () => {
  const NOON = '2026-08-10T18:00:00.000Z'; // 12:00 Denver

  it('calls tier 0 immediately and escalates on schedule', () => {
    const alert = alertFixture({ opened_at: NOON });
    const runs = replay(alert, NOON, '2026-08-10T19:00:00.000Z');
    expect(sends(runs).map((s) => `${s.at} tier ${s.tier}`)).toEqual([
      '2026-08-10T18:00:00.000Z tier 0',
      '2026-08-10T18:15:00.000Z tier 1',
      '2026-08-10T18:45:00.000Z tier 2',
    ]);
    expect(holds(runs)).toEqual([]);
  });

  it('a rule with no quiet hours is never silenced', () => {
    expect(isSilenced(alertFixture({ quiet_hours: null }), new Date(OPENED_AT))).toBe(false);
  });

  it('still gives up after MAX_ATTEMPTS_PER_RECIPIENT real failures', () => {
    const failed = (n: number): DeliveryReceipt => ({
      channel: 'sms',
      status: 'failed',
      tier: 0,
      at: `2026-08-10T18:0${n}:00.000Z`,
      recipient_id: RANCH_CELL.id,
    });
    const alert = alertFixture({
      opened_at: NOON,
      deliveries: [failed(0), failed(1), failed(2)],
    });
    expect(attemptsFor(alert.deliveries, 0, RANCH_CELL.id)).toBe(MAX_ATTEMPTS_PER_RECIPIENT);
    // Exhausted at tier 0 -> the chain steps past it to tier 1 rather than
    // stalling. Tier 1 is due because the anchor is now the first failure.
    const plan = planDispatch(alert, new Date('2026-08-10T18:20:00.000Z'));
    expect(plan.map((p) => `${p.action} ${p.tier}`)).toEqual(['send 1']);
  });

  it('never re-sends to a settled pair', () => {
    const alert = alertFixture({ opened_at: NOON });
    replay(alert, NOON, NOON);
    expect(alreadySettled(alert.deliveries, 0, RANCH_CELL.id)).toBe(true);
    expect(planDispatch(alert, new Date(NOON))).toEqual([]);
  });

  // This case used to assert `unconfigured` was TERMINAL. It was, and that was
  // the second way this system could lose a message forever.
  //
  // `unconfigured` means the rail had no credentials at the instant we looked.
  // That is a fact about our setup, not about the alert, and it stops being
  // true the moment the owner pastes an API key. Marking it terminal meant
  // every alert open during setup had its SMS killed permanently — including
  // after the credentials landed. The project sat in exactly that state while
  // Twilio was being wired up, so one dispatcher run in that window would have
  // silently burned every alert open on the farm.
  //
  // The correct shape is the one quiet hours already needed: not terminal, so
  // it resumes; recorded once, so it does not flood; and not counted as an
  // attempt, so our own missing config never spends a recipient's retries.
  it('does not treat unconfigured as terminal — a dark rail resumes when credentials arrive', () => {
    const alert = alertFixture({
      opened_at: NOON,
      deliveries: [
        {
          channel: 'sms',
          status: 'unconfigured',
          tier: 0,
          at: NOON,
          recipient_id: RANCH_CELL.id,
        },
      ],
    });

    expect(alreadySettled(alert.deliveries, 0, RANCH_CELL.id)).toBe(false);
    expect(attemptsFor(alert.deliveries, 0, RANCH_CELL.id)).toBe(0);

    // So the first run after the rail comes up reaches this recipient.
    expect(planDispatch(alert, new Date(NOON)).map((p) => `${p.action} ${p.tier}`)).toEqual([
      'send 0',
    ]);
  });

  // The flood guard that pays for the above. planDispatch keeps proposing the
  // send — it cannot know whether the rail is dark this minute, index.ts owns
  // that — so the dedup lives at the write. Without it an unconfigured rail
  // appends a fresh receipt every five minutes for as long as the alert is open.
  it('records unconfigured exactly once per pair, however many runs go by', () => {
    const alert = alertFixture({
      opened_at: NOON,
      deliveries: [
        {
          channel: 'sms',
          status: 'unconfigured',
          tier: 0,
          at: NOON,
          recipient_id: RANCH_CELL.id,
        },
      ],
    });
    expect(alreadyHeld(alert.deliveries, 0, RANCH_CELL.id, 'unconfigured')).toBe(true);
    // A quiet-hours hold is a different thing on the same pair, so the two
    // guards can never mask one another.
    expect(alreadyHeld(alert.deliveries, 0, RANCH_CELL.id)).toBe(false);
  });
});
