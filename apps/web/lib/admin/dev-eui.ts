// DevEUI normalization — the single most load-bearing string in provisioning.
//
// The ingest function looks the device up with an EXACT match on the
// upper-cased value (`dev_eui=eq.${devEUI.toUpperCase()}`), and an unknown
// DevEUI is logged and dropped, never auto-created (CLAUDE.md #10). A device
// registered as `24d124...` therefore ingests nothing, silently, forever.
// Every write path in the console runs through normalizeDevEui().
//
// Installers read the value off a label, a QR code, or an NFC tap; those
// sources use different separators, so separators are stripped rather than
// rejected. Anything that is not 16 hex digits after stripping is refused —
// guessing at a mistyped EUI is worse than a failed form.

const SEPARATORS = /[\s:.\-_]/g;
const HEX16 = /^[0-9A-F]{16}$/;

export type DevEuiResult =
  | { ok: true; value: string }
  | { ok: false; value: string; message: string };

export function normalizeDevEui(raw: string): DevEuiResult {
  const stripped = raw.trim().replace(SEPARATORS, '').toUpperCase();

  if (stripped.length === 0) {
    return { ok: false, value: stripped, message: 'Enter the DevEUI from the sensor label.' };
  }
  if (!/^[0-9A-F]+$/.test(stripped)) {
    return {
      ok: false,
      value: stripped,
      message: 'A DevEUI is hex only — digits 0-9 and letters A-F.',
    };
  }
  if (!HEX16.test(stripped)) {
    return {
      ok: false,
      value: stripped,
      message: `A DevEUI is 16 hex digits. That one has ${stripped.length}.`,
    };
  }
  return { ok: true, value: stripped };
}

/** 24D124707E04ABCD → 24D1 24 70 7E 04 AB CD, grouped for reading back aloud. */
export function formatDevEui(value: string): string {
  return (value.match(/.{1,4}/g) ?? [value]).join(' ');
}

/**
 * Pull a DevEUI out of whatever a QR scan produced. Milesight labels encode
 * either the bare EUI or a delimited SN/EUI pair; some print a URL with the
 * EUI in a query parameter. Take the first 16-hex run and let
 * normalizeDevEui() have the final say.
 */
export function devEuiFromScan(payload: string): DevEuiResult {
  const direct = normalizeDevEui(payload);
  if (direct.ok) return direct;

  const candidates = payload.toUpperCase().match(/[0-9A-F]{16}/g);
  const first = candidates?.[0];
  if (first) return normalizeDevEui(first);

  return {
    ok: false,
    value: '',
    message: 'No DevEUI in that code. Type it from the label instead.',
  };
}
