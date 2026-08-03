// Installer sync endpoint.
//
// The handset queues captures locally and posts them here whenever it has
// signal. A route handler rather than a server action because the payload is
// multipart (the install photo) and the caller is a retry loop, not a form.
//
// IDEMPOTENCY. `devices.dev_eui` is globally unique, so a replayed capture
// collides on insert. That collision is treated as success when the existing
// row is the same device on the same farm — a truck cresting a hill twice must
// not produce an error the installer has to interpret.
//
// ORDERING. The device row is written before the photo is uploaded. A storage
// failure must never cost us the registration: the device lands, the photo is
// reported as failed, and the queue keeps the image for a later attempt.
import { NextResponse } from 'next/server';
import { withAudit } from '@/lib/admin/audit';
import { getStaffContext, atLeast } from '@/lib/admin/guard';
import { normalizeDevEui } from '@/lib/admin/dev-eui';
import { DEVICE_ROLES, bomItem, blockedReason, type DeviceRole } from '@/lib/admin/bom';
import { buildCurve, CURVES } from '@/lib/admin/install/calibration';
import type { DraftInstall, SyncResponse } from '@/lib/admin/install/types';
import { geometryToEwkt } from '@/lib/map/geometry';

/** SET BEFORE LAUNCH — Supabase Storage bucket for install photos. */
const INSTALL_PHOTO_BUCKET = 'install-photos';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(message: string, status = 400): NextResponse<SyncResponse> {
  return NextResponse.json({ ok: false, message }, { status });
}

export async function POST(request: Request): Promise<NextResponse<SyncResponse>> {
  const context = await getStaffContext();
  if (!context || !atLeast(context.platformRole, 'installer')) {
    return bad('This needs a Mac’s Tech staff account.', 403);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad('That upload did not arrive intact. It stays queued.');
  }

  const rawDraft = form.get('draft');
  if (typeof rawDraft !== 'string') return bad('No capture in that request.');

  let draft: DraftInstall;
  try {
    draft = JSON.parse(rawDraft) as DraftInstall;
  } catch {
    return bad('That capture could not be read.');
  }

  // ── validate ──────────────────────────────────────────────────────────────
  if (!UUID.test(draft.farmId ?? '')) return bad('Pick a farm.');

  const eui = normalizeDevEui(draft.devEui ?? '');
  if (!eui.ok) return bad(eui.message);

  const role = draft.role;
  if (!DEVICE_ROLES.includes(role as DeviceRole)) return bad('Pick a role.');

  const model = (draft.model ?? '').trim();
  if (!model) return bad('Pick a model.');
  const blocked = blockedReason(model);
  if (blocked) return bad(`${model}: ${blocked}`);

  const curve = buildCurve(role, asStringMap(draft.calibration));
  if (!curve.ok && CURVES[role].fields.length > 0) {
    return bad(`Calibration is incomplete: ${curve.missing.join(', ')}.`);
  }

  const { data: farm } = await context.supabase
    .from('farms')
    .select('id, org_id')
    .eq('id', draft.farmId)
    .maybeSingle();
  if (!farm) return bad('That farm is gone.');

  // ── already here? ─────────────────────────────────────────────────────────
  const { data: existing } = await context.supabase
    .from('devices')
    .select('id, farm_id')
    .eq('dev_eui', eui.value)
    .maybeSingle();

  if (existing) {
    if (existing.farm_id !== farm.id) {
      return bad(`${eui.value} is already installed on another farm. Check the label.`);
    }
    return NextResponse.json({
      ok: true,
      message: 'Already registered.',
      deviceId: existing.id,
      photoUploaded: false,
    });
  }

  // ── optional: drop the mount point on the map ─────────────────────────────
  let mountedOn = UUID.test(draft.mountedOn ?? '') ? draft.mountedOn : null;

  if (!mountedOn && draft.newPoint) {
    const point = draft.newPoint;
    if (
      Number.isFinite(point.lng) &&
      Number.isFinite(point.lat) &&
      (point.kind === 'gate' || point.kind === 'trough')
    ) {
      const created = await withAudit<{ id: string }>(
        {
          action: 'map_features.create',
          table: 'map_features',
          orgId: farm.org_id,
          farmId: farm.id,
          reason: `installer placed a ${point.kind} for ${eui.value}`,
          details: { kind: point.kind },
        },
        async (supabase) =>
          supabase
            .from('map_features')
            .insert({
              org_id: farm.org_id,
              farm_id: farm.id,
              kind: point.kind,
              name: point.name || `${point.kind} ${eui.value.slice(-4)}`,
              geom: geometryToEwkt({ type: 'Point', coordinates: [point.lng, point.lat] }),
              source: 'hand_drawn',
            })
            .select('id')
            .single(),
      );
      if (created.ok) mountedOn = created.data.id;
    }
  }

  // ── the device ────────────────────────────────────────────────────────────
  const bom = bomItem(model);

  const device = await withAudit<{ id: string }>(
    {
      action: 'devices.install',
      table: 'devices',
      orgId: farm.org_id,
      farmId: farm.id,
      recordId: eui.value,
      reason: `installed ${model} as ${role}`,
      details: {
        devEui: eui.value,
        model,
        role,
        // The signal check has no home in `readings` — the canonical metric
        // vocabulary is closed and RSSI is not in it. It lives here.
        signalCheck: draft.signal ?? null,
        placedFeature: mountedOn,
        notes: draft.notes ?? '',
        capturedAt: draft.capturedAt ?? null,
        bomLine: bom?.label ?? 'not in the BOM',
      },
    },
    async (supabase) =>
      supabase
        .from('devices')
        .insert({
          org_id: farm.org_id,
          farm_id: farm.id,
          // UPPER CASE, always: the webhook looks devices up with an exact
          // match on the upper-cased value and drops anything it cannot find.
          dev_eui: eui.value,
          model,
          role,
          mounted_on: mountedOn,
          install_date: new Date().toISOString().slice(0, 10),
          installer_user_id: context.user.id,
          status: 'installed',
        })
        .select('id')
        .single(),
  );

  if (!device.ok) return bad(device.error, 409);

  // ── versioned calibration ─────────────────────────────────────────────────
  if (CURVES[role].fields.length > 0) {
    await withAudit<{ id: string }>(
      {
        action: 'device_calibrations.create',
        table: 'device_calibrations',
        orgId: farm.org_id,
        farmId: farm.id,
        recordId: device.data.id,
        reason: `calibration v1 for ${eui.value}`,
        details: { kind: CURVES[role].kind },
      },
      async (supabase) =>
        supabase
          .from('device_calibrations')
          .insert({
            org_id: farm.org_id,
            device_id: device.data.id,
            // First version. Later corrections ADD a version — a curve is
            // never mutated, or history stops being re-derivable.
            version: 1,
            effective_from: new Date().toISOString(),
            curve: curve.curve,
            created_by: context.user.id,
          })
          .select('id')
          .single(),
    );
  }

  // ── photo, last and non-blocking ──────────────────────────────────────────
  let photoUploaded = false;
  let photoError: string | undefined;

  const photo = form.get('photo');
  if (photo instanceof File && photo.size > 0) {
    const path = `${farm.id}/${eui.value}-${Date.now()}.jpg`;
    const { error } = await context.supabase.storage
      .from(INSTALL_PHOTO_BUCKET)
      .upload(path, photo, { contentType: photo.type || 'image/jpeg', upsert: false });

    if (error) {
      photoError = `Photo not stored: ${error.message}`;
    } else {
      photoUploaded = true;
      await context.supabase
        .from('devices')
        .update({ install_photo_path: path })
        .eq('id', device.data.id);
    }
  }

  return NextResponse.json({
    ok: true,
    message: 'Installed.',
    deviceId: device.data.id,
    photoUploaded,
    photoError,
  });
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || item === undefined) continue;
    out[key] = String(item);
  }
  return out;
}
