// Envelope routing: MDP webhook envelope (or a second-source envelope) →
// { readings, health?, unmapped } (docs/ARCHITECTURE.md §4.2, §5).
//
// Pure functions, no I/O. Callers (the mdp-webhook edge function) persist the
// raw envelope FIRST, then call this; a NormalizeError here dead-letters the
// event, it never loses it.

import type {
  DirectEnvelope,
  MdpDeviceData,
  MdpEnvelope,
  NormalizeResult,
  TelemetryEnvelope,
} from './types.ts';
import { resolveModelMapping } from './models/index.ts';

/** Structurally invalid envelope — the caller dead-letters the raw event. */
export class NormalizeError extends Error {
  override readonly name = 'NormalizeError';
}

/**
 * Parses `eventCreatedTime` (Unix **seconds**; JSON string in the documented
 * MDP example, number tolerated).
 */
export function parseEventCreatedTime(value: unknown): number {
  let n: number | undefined;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  if (n === undefined || !Number.isFinite(n) || n <= 0) {
    throw new NormalizeError(`eventCreatedTime is not a Unix-seconds timestamp: ${String(value)}`);
  }
  return n;
}

function emptyResult(): NormalizeResult {
  return { readings: [], unmapped: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Routes decoded named fields through the model's mapping. */
function mapPayload(
  model: string,
  payload: Record<string, unknown>,
  eventCreatedTime: number,
): NormalizeResult {
  const mapping = resolveModelMapping(model);
  if (mapping === undefined) {
    // Unknown model: nothing is guessed, nothing is dropped.
    return {
      readings: [],
      unmapped: Object.entries(payload).map(([field, value]) => ({
        field,
        value,
        reason: 'unknown_model' as const,
        detail: `no mapping for model ${model}`,
      })),
    };
  }
  const mapped = mapping.map(payload, eventCreatedTime);
  return { readings: mapped.readings, unmapped: mapped.unmapped };
}

function normalizeDeviceData(envelope: MdpEnvelope, eventCreatedTime: number): NormalizeResult {
  const data = envelope.data;
  if (!isRecord(data) || typeof data.type !== 'string') {
    throw new NormalizeError('DEVICE_DATA envelope has no data.type');
  }
  const typed = data as Partial<MdpDeviceData> & { type: string };

  // Connectivity transitions feed device_health directly — free
  // sensor-silent detection, no polling job (§4.2).
  if (typed.type === 'ONLINE' || typed.type === 'OFFLINE') {
    const result = emptyResult();
    result.health = { online: typed.type === 'ONLINE' };
    if (isRecord(typed.payload)) {
      for (const [field, value] of Object.entries(typed.payload)) {
        result.unmapped.push({ field, value, reason: 'metadata', detail: 'connectivity envelope' });
      }
    }
    return result;
  }

  // PROPERTY is the normal reading path; EVENT (device-defined occurrence)
  // and SERVICE (service-invocation result) carry the same TSL-decoded named
  // fields, so they route through the same mapping — measurements become
  // readings, alarm enums and echoes land in `unmapped` with reasons.
  if (typed.type === 'PROPERTY' || typed.type === 'EVENT' || typed.type === 'SERVICE') {
    const model = typed.deviceProfile?.model;
    if (typeof model !== 'string' || model === '') {
      throw new NormalizeError(`DEVICE_DATA ${typed.type} envelope has no deviceProfile.model`);
    }
    const payload = typed.payload === undefined ? {} : typed.payload;
    if (!isRecord(payload)) {
      throw new NormalizeError(`DEVICE_DATA ${typed.type} payload is not an object`);
    }
    return mapPayload(model, payload, eventCreatedTime);
  }

  // Unrecognized data.type: acknowledged, surfaced, never guessed.
  const result = emptyResult();
  result.ignored = true;
  result.unmapped.push({
    field: 'data.type',
    value: typed.type,
    reason: 'unknown_field',
    detail: 'unrecognized DEVICE_DATA data.type',
  });
  return result;
}

/**
 * Normalizes one MDP webhook envelope.
 *
 * - PROPERTY → readings (EVENT/SERVICE route through the same mapping)
 * - ONLINE/OFFLINE → health.online
 * - TASK_DATA / WEBHOOK_TEST → ignored-but-acknowledged
 * - SYSTEM_MESSAGES → systemMessage: true (webhook raises a staff P1 —
 *   this is the only warning that MDP is dropping data)
 *
 * Throws NormalizeError on structurally invalid envelopes; the caller has
 * already persisted the raw event and dead-letters it.
 */
export function normalizeEnvelope(envelope: MdpEnvelope): NormalizeResult {
  // OBSERVED 2026-08-03 on live callbacks: MDP sends `eventId` (lowercase d),
  // not the documented `eventID`. Accept either — requiring the documented
  // spelling dead-letters every real delivery.
  const eventId =
    (envelope as { eventId?: unknown }).eventId ??
    (envelope as { eventID?: unknown }).eventID;
  if (typeof eventId !== 'string' || eventId === '') {
    throw new NormalizeError('envelope eventId/eventID missing');
  }
  const eventCreatedTime = parseEventCreatedTime(envelope.eventCreatedTime);

  switch (envelope.eventType) {
    case 'DEVICE_DATA':
      return normalizeDeviceData(envelope, eventCreatedTime);
    case 'TASK_DATA':
    case 'WEBHOOK_TEST': {
      const result = emptyResult();
      result.ignored = true;
      return result;
    }
    case 'SYSTEM_MESSAGES': {
      const result = emptyResult();
      result.systemMessage = true;
      return result;
    }
    default: {
      const result = emptyResult();
      result.ignored = true;
      result.unmapped.push({
        field: 'eventType',
        value: envelope.eventType,
        reason: 'unknown_field',
        detail: 'unrecognized envelope eventType',
      });
      return result;
    }
  }
}

function normalizeDirect(envelope: DirectEnvelope): NormalizeResult {
  if (typeof envelope.eventId !== 'string' || envelope.eventId === '') {
    throw new NormalizeError('direct envelope eventId missing');
  }
  const eventCreatedTime = parseEventCreatedTime(envelope.eventCreatedTime);
  if (envelope.kind === 'health') {
    const result = emptyResult();
    result.health = { online: envelope.online };
    return result;
  }
  const payload = envelope.payload === undefined ? {} : envelope.payload;
  if (!isRecord(payload)) {
    throw new NormalizeError('direct envelope payload is not an object');
  }
  if (typeof envelope.model !== 'string' || envelope.model === '') {
    throw new NormalizeError('direct envelope has no model');
  }
  return mapPayload(envelope.model, payload, eventCreatedTime);
}

/**
 * Source-agnostic entry point (ARCHITECTURE §5.7): MDP today, gateway-direct
 * or LTE tracker feeds tomorrow — all produce the same CanonicalReading
 * stream with no schema change.
 */
export function normalizeTelemetry(input: TelemetryEnvelope): NormalizeResult {
  if (input.source === 'mdp') return normalizeEnvelope(input.envelope);
  return normalizeDirect(input.envelope);
}
