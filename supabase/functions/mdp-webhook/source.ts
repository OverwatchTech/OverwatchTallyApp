// source.ts — TelemetrySource abstraction (ARCHITECTURE §5.7).
//
// The handler orchestrates a TelemetrySource; `MilesightMdpSource` is the
// first implementation. A second source — `GatewayDirectSource` (tracker via
// the gateway's embedded NS) or a third-party LTE tracker webhook (both in
// docs/ROADMAP.md) — drops in by implementing this interface, WITHOUT a schema
// migration: the ingest tables are source-neutral (`envelope jsonb`, text ids,
// text event types). The `mdp_event_id` column name is historical; it stores
// whichever idempotency key the source defines.
//
// `parse` is pure shape-validation + canonical lift. It must not touch I/O —
// that keeps every source unit-testable and keeps the §5.1 ordering guarantee
// (validate before any database access) structural rather than disciplinary.
//
// Normalization pairs with the source: for MDP it is `normalizeEnvelope` in
// ./normalize_seam.ts (the packages/normalize seam). A future second source
// brings its own envelope type and its own normalize function behind the same
// call shape in index.ts.

import { validateEnvelope, type MdpEnvelope } from './validate.ts';

/** What every source must distill an incoming request body into. */
export interface ParsedIngest<E> {
  /** Source-scoped idempotency key — lands in the `mdp_event_id` columns. */
  sourceEventId: string;
  /** Source vocabulary, stored verbatim in `raw_events.event_type`. */
  eventType: string;
  /** The source's own clock as ISO timestamptz; null if the source has none.
   *  Stored beside `received_at`, never instead of it (§5.6). */
  eventCreatedTime: string | null;
  /** The verbatim envelope — persisted BEFORE any further parsing (§5.3). */
  envelope: E;
}

export type SourceParseResult<E> =
  | { ok: true; parsed: ParsedIngest<E> }
  | { ok: false; reason: string };

export interface TelemetrySource<E = unknown> {
  readonly name: string;
  /** Pure validation + canonical lift. No I/O. */
  parse(body: unknown): SourceParseResult<E>;
}

export class MilesightMdpSource implements TelemetrySource<MdpEnvelope> {
  readonly name = 'milesight_mdp';

  parse(body: unknown): SourceParseResult<MdpEnvelope> {
    const v = validateEnvelope(body);
    if (!v.ok) return { ok: false, reason: v.reason };
    return {
      ok: true,
      parsed: {
        sourceEventId: v.envelope.eventID,
        eventType: v.envelope.eventType,
        eventCreatedTime: v.eventCreatedTimeIso,
        envelope: v.envelope,
      },
    };
  }
}
