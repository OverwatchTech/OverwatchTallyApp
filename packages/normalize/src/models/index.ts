// Model mapping registry. One mapping per BOM model (ARCHITECTURE §7);
// resolution is by `deviceProfile.model` prefix so regional/variant suffixes
// (e.g. EM400-UDL-C100) route correctly.

import type { ModelMapping } from './shared.ts';
import { em300Di } from './em300-di.ts';
import { em300Mcs } from './em300-mcs.ts';
import { em400Udl } from './em400-udl.ts';
import { em410Rdl } from './em410-rdl.ts';
import { em500Smtc } from './em500-smtc.ts';
import { em500Swl } from './em500-swl.ts';
import { em500Udl } from './em500-udl.ts';
import { uc100 } from './uc100.ts';
import { uc50x } from './uc50x.ts';

export const MODEL_MAPPINGS: readonly ModelMapping[] = [
  em400Udl,
  em500Udl,
  em410Rdl,
  em300Di,
  em300Mcs,
  em500Swl,
  em500Smtc,
  uc50x,
  uc100,
];

/** Finds the mapping serving a `deviceProfile.model`, or undefined. */
export function resolveModelMapping(model: string): ModelMapping | undefined {
  return MODEL_MAPPINGS.find((m) => m.matches(model));
}

export type { FieldRule, MappedPayload, ModelMapping, StateDecoder } from './shared.ts';
export { asFiniteNumber, twoState } from './shared.ts';
export { em300Di, em300Mcs, em400Udl, em410Rdl, em500Smtc, em500Swl, em500Udl, uc100, uc50x };
