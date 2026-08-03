// infer-kind.mjs — kind inference for KML placemark names (DATA-MODEL §2).
//
// Rule order is load-bearing:
//   - "hay stack" before building ("Hay Stack 12" vs "Hay Barn (Equipment Barn)")
//   - building before alley/pen ("Welding Shop", "Barn(HQ)")
//   - alley before pen ("North Lot Alley(Buro Only)" contains "Lot" too)
//   - feed before pen ("North Feed 2" is a feed lane, not a pen)
//   - "buro north" added so "Buro North 4" (no generic keyword) lands as pen;
//     "north lot" is already covered by /lot\b/.
// Unmatched names are never guessed silently: callers seed them as
// 'equipment_zone' with a "kind needs review" note and report them.

const RULES = /** @type {const} */ ([
  ['gate', /gate/i],
  ['hay_stack', /hay stack/i],
  ['building', /barn|shop|shed|she\b/i],
  ['alley', /alley/i],
  ['feed_lane', /feed/i],
  ['pen', /pen|lot\b|lot \d|holding|recovery|buro north/i],
]);

export const FALLBACK_KIND = 'equipment_zone';

/**
 * Infer a map_features.kind from a placemark name.
 * @param {string} name
 * @returns {{ kind: string, matched: boolean }}
 */
export function inferKind(name) {
  for (const [kind, re] of RULES) {
    if (re.test(name)) return { kind, matched: true };
  }
  return { kind: FALLBACK_KIND, matched: false };
}

/**
 * Extract an operational-restriction suffix — "(Buro Only)", "(Mustang Only)" —
 * into the restrictions column. Only parenthesized suffixes ending in "Only"
 * qualify; "(HQ)" and "(Equipment Barn)" are descriptive, not restrictions.
 * The name itself stays verbatim (suffix included).
 * @param {string} name
 * @returns {string | null}
 */
export function extractRestriction(name) {
  const m = /\(([^()]*\bonly)\)\s*$/i.exec(name);
  return m ? m[1].trim() : null;
}
