// Dead-letter reprocessing.
//
// ARCHITECTURE §5.3: the raw envelope is persisted BEFORE normalization
// precisely so a parse failure is recoverable. MDP keeps one day at most, so
// this is the only way a failed event is ever recovered — after that window the
// raw row in our database is the sole surviving copy.
//
// MIRROR WARNING. The mapping below reproduces
// `supabase/functions/mdp-webhook/normalize_seam.ts`: same channel suffix
// (`adc_v_2`), same skip cases, same column mapping. It is a mirror rather than
// an import because that file is Deno-flavoured (extensioned relative imports)
// and lives in a tree this phase does not touch. Both call the SAME pure
// `normalizeEnvelope` from `@overwatch/normalize`, so the per-model mappings
// cannot drift — only this thin adapter could. Change one, change the other.
import { normalizeEnvelope, parseEventCreatedTime } from '@overwatch/normalize';
import type { MdpEnvelope } from '@overwatch/normalize';
import type { AdminClient } from './guard';

export interface ReprocessOutcome {
  ok: boolean;
  message: string;
  readingsWritten: number;
}

interface RawRow {
  id: number;
  org_id: string;
  farm_id: string;
  mdp_event_id: string;
  envelope: unknown;
  received_at: string;
}

function devEuiOf(envelope: MdpEnvelope): string | null {
  const data = envelope.data;
  if (!data || typeof data !== 'object') return null;
  const profile = (data as Record<string, unknown>).deviceProfile;
  if (!profile || typeof profile !== 'object') return null;
  const devEUI = (profile as Record<string, unknown>).devEUI;
  return typeof devEUI === 'string' && devEUI.length > 0 ? devEUI : null;
}

/**
 * Re-run one dead-lettered envelope. Success marks the raw row normalized and
 * resolves the queue entry; failure records the NEW error and bumps
 * retry_count, leaving the entry open — a failed retry never silently closes.
 */
export async function reprocessDeadLetter(
  supabase: AdminClient,
  deadLetterId: number,
  actorUserId: string,
): Promise<ReprocessOutcome> {
  const { data: dlq } = await supabase
    .from('dead_letter_events')
    .select('id, raw_event_id, farm_id, org_id, retry_count, resolved_at')
    .eq('id', deadLetterId)
    .maybeSingle();

  if (!dlq) return { ok: false, message: 'That queue entry is gone.', readingsWritten: 0 };
  if (dlq.resolved_at) {
    return { ok: false, message: 'Already resolved.', readingsWritten: 0 };
  }
  if (dlq.raw_event_id === null) {
    return {
      ok: false,
      message: 'No raw envelope was recorded for this failure. There is nothing to replay.',
      readingsWritten: 0,
    };
  }

  const { data: raw } = await supabase
    .from('raw_events')
    .select('id, org_id, farm_id, mdp_event_id, envelope, received_at')
    .eq('id', dlq.raw_event_id)
    .limit(1)
    .maybeSingle();

  if (!raw) {
    return {
      ok: false,
      message: 'The raw envelope has aged out of retention. This event cannot be recovered.',
      readingsWritten: 0,
    };
  }

  try {
    const written = await replay(supabase, raw as RawRow);
    await supabase
      .from('dead_letter_events')
      .update({ resolved_at: new Date().toISOString(), resolved_by: actorUserId })
      .eq('id', deadLetterId);
    return {
      ok: true,
      message:
        written === 0
          ? 'Replayed. The envelope carries no canonical readings, so nothing was written.'
          : `Replayed. ${written} reading${written === 1 ? '' : 's'} written.`,
      readingsWritten: written,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'Replay failed.';
    await supabase
      .from('dead_letter_events')
      .update({ retry_count: dlq.retry_count + 1, error: message })
      .eq('id', deadLetterId);
    return { ok: false, message, readingsWritten: 0 };
  }
}

async function replay(supabase: AdminClient, raw: RawRow): Promise<number> {
  const envelope = raw.envelope as MdpEnvelope;
  const devEUI = devEuiOf(envelope);
  if (!devEUI) throw new Error('Envelope carries no devEUI. It cannot be attributed to a device.');

  // Exact match on the upper-cased value — the same lookup the webhook does.
  // An unknown DevEUI is never auto-created (CLAUDE.md #10).
  const { data: device } = await supabase
    .from('devices')
    .select('id')
    .eq('farm_id', raw.farm_id)
    .eq('dev_eui', devEUI.toUpperCase())
    .maybeSingle();

  if (!device) {
    throw new Error(
      `No device ${devEUI.toUpperCase()} on this farm. Register it before replaying.`,
    );
  }

  const result = normalizeEnvelope(envelope);
  const eventCreatedTime = new Date(parseEventCreatedTime(envelope.eventCreatedTime) * 1000);

  if (result.health && typeof result.health.online === 'boolean') {
    await supabase.from('device_health').upsert(
      {
        device_id: device.id,
        org_id: raw.org_id,
        farm_id: raw.farm_id,
        online: result.health.online,
        last_online_change_at: raw.received_at,
        last_seen_at: raw.received_at,
        updated_at: raw.received_at,
      },
      { onConflict: 'device_id' },
    );
    await markNormalized(supabase, raw);
    return 0;
  }

  const rows = result.readings.map((reading) => ({
    org_id: raw.org_id,
    farm_id: raw.farm_id,
    device_id: device.id,
    // Multi-channel readings suffix the metric so `readings.metric` stays one
    // flat text column — identical to the webhook seam.
    metric: reading.channel === undefined ? reading.metric : `${reading.metric}_${reading.channel}`,
    value: typeof reading.value === 'number' ? reading.value : null,
    value_text: typeof reading.valueText === 'string' ? reading.valueText : null,
    received_at: raw.received_at,
    event_created_time: eventCreatedTime.toISOString(),
    mdp_event_id: raw.mdp_event_id,
  }));

  if (rows.length > 0) {
    const { error } = await supabase.from('readings').insert(rows);
    if (error) throw new Error(error.message);
  }

  await markNormalized(supabase, raw);
  return rows.length;
}

async function markNormalized(supabase: AdminClient, raw: RawRow): Promise<void> {
  // raw_events is partitioned on received_at; including it prunes the update
  // to one partition instead of scanning every month.
  await supabase
    .from('raw_events')
    .update({ status: 'normalized', processed_at: new Date().toISOString() })
    .eq('id', raw.id)
    .eq('received_at', raw.received_at);
}
