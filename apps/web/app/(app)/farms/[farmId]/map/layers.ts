// Layer rail model. The mockup's rail groups toggles under uppercase section
// labels; ours groups the farm's own feature kinds the way a rancher would
// group them on the ground, and only shows a group when the farm actually has
// something in it — an empty "Water (0)" switch is furniture, not information.
//
// Vocabulary is KIND_LABELS (CLAUDE.md #5), pluralised for a switch label.
import type { FeatureKind, MapFeatureRow } from '@/lib/map/features';

/** Plural switch labels. KIND_LABELS is singular and stays the source. */
const PLURAL: Record<FeatureKind, string> = {
  pen: 'Pens',
  alley: 'Alleys',
  feed_lane: 'Feed lanes',
  hay_stack: 'Hay stacks',
  building: 'Buildings',
  pasture: 'Pastures',
  water_source: 'Water',
  trough: 'Troughs',
  gate: 'Gates',
  equipment_zone: 'Equipment zones',
};

const GROUPS: { label: string; kinds: FeatureKind[] }[] = [
  { label: 'Ground', kinds: ['pen', 'pasture', 'alley', 'feed_lane', 'equipment_zone'] },
  { label: 'Water', kinds: ['water_source', 'trough'] },
  { label: 'Structures', kinds: ['hay_stack', 'building'] },
  { label: 'Access', kinds: ['gate'] },
];

export interface LayerSwitch {
  kind: FeatureKind;
  label: string;
  count: number;
}

export interface LayerGroup {
  label: string;
  switches: LayerSwitch[];
}

/** Counts per kind, in the farm's own data. */
export function countByKind(rows: MapFeatureRow[]): Map<FeatureKind, number> {
  const counts = new Map<FeatureKind, number>();
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  return counts;
}

/** Rail groups for the kinds this farm actually has, in ground order. */
export function layerGroups(counts: Map<FeatureKind, number>): LayerGroup[] {
  const groups: LayerGroup[] = [];
  for (const group of GROUPS) {
    const switches: LayerSwitch[] = [];
    for (const kind of group.kinds) {
      const count = counts.get(kind);
      if (!count) continue;
      switches.push({ kind, label: PLURAL[kind], count });
    }
    if (switches.length > 0) groups.push({ label: group.label, switches });
  }
  return groups;
}

/** "42 pens · 91 gates · 18 hay stacks" — the rail's facility line. */
export function factsLine(counts: Map<FeatureKind, number>): { label: string; count: number }[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => ({ label: PLURAL[kind].toLowerCase(), count }));
}
