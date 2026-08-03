// Shapes shared by the installer PWA and the sync endpoint.
//
// Pure types and pure validation only — this module is imported by a client
// component that has to run with no network at all.
import type { DeviceRole } from '../bom';

/**
 * What the installer observed on the ToolBox app / NFC readout at the mount
 * point. There is no browser API for LoRa signal, so these are typed by a
 * person, and they are recorded as such.
 *
 * They are NOT written to `readings`: `readings.metric` is a closed canonical
 * vocabulary (SI, per @overwatch/normalize) and RSSI is not in it. Inventing a
 * metric string to make a number fit would corrupt the one table every chart
 * trusts. The signal check lands on the install's audit row instead — append
 * only, staff only, permanently attached to who installed what and when.
 */
export interface SignalCheck {
  rssiDbm: number | null;
  snrDb: number | null;
  gatewayLabel: string;
  passed: boolean;
  note: string;
}

/** A new point feature dropped at the mount point (gate and trough only). */
export interface NewPoint {
  lng: number;
  lat: number;
  kind: 'gate' | 'trough';
  name: string;
}

export interface DraftInstall {
  /** Generated on the handset. Also the idempotency key at the sync endpoint. */
  localId: string;
  farmId: string;
  /** Already normalized: 16 hex, UPPER CASE. */
  devEui: string;
  model: string;
  role: DeviceRole;
  /** Existing map feature this sensor is mounted on. */
  mountedOn: string | null;
  newPoint: NewPoint | null;
  signal: SignalCheck;
  /** The full conversion curve for this role — never an offset. */
  calibration: Record<string, number | string | boolean | null>;
  notes: string;
  capturedAt: string;
}

export type QueueState = 'queued' | 'syncing' | 'synced' | 'failed';

export interface QueuedInstall {
  draft: DraftInstall;
  state: QueueState;
  attempts: number;
  lastError: string | null;
  /** Set once the device row exists upstream. */
  syncedAt: string | null;
  /** Reported separately: a photo that failed to upload never blocks the device. */
  photoStatus: 'none' | 'pending' | 'uploaded' | 'failed';
  photoError: string | null;
}

export interface SyncResponse {
  ok: boolean;
  message: string;
  deviceId?: string;
  photoUploaded?: boolean;
  photoError?: string;
}

/** Everything the handset needs cached to work with no signal. */
export interface InstallContext {
  farms: {
    id: string;
    name: string;
    orgName: string;
    features: { id: string; name: string; kind: string }[];
  }[];
  cachedAt: string;
}
