// Hand-written declarations for infer-kind.mjs (plain-Node seed tooling —
// kept as .mjs so `node seeds/generate-seed.mjs` runs without a build step).

export type FeatureKind =
  | 'pen'
  | 'alley'
  | 'feed_lane'
  | 'hay_stack'
  | 'building'
  | 'pasture'
  | 'water_source'
  | 'trough'
  | 'gate'
  | 'equipment_zone';

export declare const FALLBACK_KIND: 'equipment_zone';

export declare function inferKind(name: string): {
  kind: FeatureKind;
  matched: boolean;
};

export declare function extractRestriction(name: string): string | null;
