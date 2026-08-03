// @overwatch/normalize — MDP decoded payload → canonical metrics + SI units.
//
// A lookup-and-conversion layer, not a bit parser: MDP delivers payloads
// TSL-DECODED as named fields (docs/ARCHITECTURE.md §4.2). Every per-model
// mapping in src/models/ was written only after verifying that model's
// payload field names against Milesight's published TSL definitions — each
// model file carries its [VERIFY] provenance header.
//
// Pure TS, no I/O, no Node imports, no npm deps: consumed by vitest/Node
// (apps, tests) and by Deno (the mdp-webhook edge function) alike.

export const PACKAGE = '@overwatch/normalize' as const;

export { METRICS } from './metrics.ts';
export type { Metric } from './metrics.ts';

export type {
  CanonicalReading,
  DeviceHealth,
  DirectEnvelope,
  MdpDataType,
  MdpDeviceData,
  MdpDeviceProfile,
  MdpEnvelope,
  MdpEventType,
  NormalizeResult,
  TelemetryEnvelope,
  TelemetrySource,
  UnmappedField,
  UnmappedReason,
} from './types.ts';

export {
  NormalizeError,
  normalizeEnvelope,
  normalizeTelemetry,
  parseEventCreatedTime,
} from './normalize.ts';

export { MODEL_MAPPINGS, resolveModelMapping } from './models/index.ts';
export type { MappedPayload, ModelMapping } from './models/index.ts';
