// Small display helpers for machine-ish labels. Full formatMeasure() (SI →
// US customary) lands in packages/ui; nothing here converts units.
import type { Database } from "@overwatch/db";

type Tier = Database["public"]["Enums"]["tier_t"];

/** tier_1 → "Tier 1" (tier names are placeholders until billing config). */
export function formatTier(tier: Tier): string {
  const n = tier.split("_")[1];
  return `Tier ${n}`;
}
