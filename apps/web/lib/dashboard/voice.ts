// Rancher phrasing for machine events (CLAUDE.md #5, #11). Plain verbs,
// sentence case, no apologies, and provenance always carried — an inferred
// number is never presented as a measured one.
import type { Database } from '@overwatch/db';

export type FeedSource = Database['public']['Enums']['feed_source_t'];
export type AlertKind = Database['public']['Enums']['alert_kind_t'];

/** Provenance tag shown beside every feed amount. */
export function feedSourceLabel(source: FeedSource): string {
  switch (source) {
    case 'sensor_derived':
      return 'sensor';
    case 'crew_logged':
      return 'crew';
    case 'truck_scale':
      return 'truck scale';
  }
}

/** Customer-facing alert headline. No LoRaWAN vocabulary, ever. */
export function alertHeadline(kind: AlertKind): string {
  switch (kind) {
    case 'trough_low':
      return 'Trough low';
    case 'refill_rate_change':
      return 'Trough refill rate changed';
    case 'intake_drop':
      return 'Water intake dropped';
    case 'schedule_missed':
      return 'Feeding missed';
    case 'gate_open_window':
      return 'Gate open off-hours';
    case 'gate_open_duration':
      return 'Gate open too long';
    case 'days_on_hand_low':
      return 'Feed on hand running low';
    case 'sensor_offline':
      return 'Sensor gone quiet';
    case 'battery_low':
      return 'Sensor battery low';
    case 'gateway_offline':
      return 'Base station offline';
    case 'mdp_system_messages':
      // Filtered out of every customer surface; label exists for /admin only.
      return 'Platform notice';
  }
}
