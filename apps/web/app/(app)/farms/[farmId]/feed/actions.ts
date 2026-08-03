'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { parseTstzRange } from '@/lib/ops/range';

export interface SetScheduleState {
  status: 'idle' | 'saved' | 'error';
  message: string;
}

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

/**
 * Create a simple 06:00 / 17:00 feed schedule for every pen that currently
 * holds a group and has no active schedule yet. Times only — no target
 * weight is invented; the target line appears once a manager sets one.
 * The button is manager-only in the UI, but RLS (manager-writable
 * feed_schedules policy) is the enforcement — a denial comes back as an
 * insert error, not a silent success.
 */
export async function setDefaultSchedule(
  _prev: SetScheduleState,
  formData: FormData,
): Promise<SetScheduleState> {
  const farmId = String(formData.get('farmId') ?? '');
  if (!farmId) {
    return { status: 'error', message: 'The farm could not be identified.' };
  }

  const supabase = await createClient();

  const { data: farm } = await supabase
    .from('farms')
    .select('id, org_id')
    .eq('id', farmId)
    .single();
  if (!farm) {
    return { status: 'error', message: 'The farm could not be identified.' };
  }

  const [{ data: placements }, { data: existing }] = await Promise.all([
    supabase.from('group_placements').select('pen_feature_id, valid').eq('farm_id', farmId),
    supabase
      .from('feed_schedules')
      .select('pen_feature_id')
      .eq('farm_id', farmId)
      .eq('active', true),
  ]);

  const now = Date.now();
  const occupiedPens = new Set<string>();
  for (const p of placements ?? []) {
    const r = parseTstzRange(p.valid);
    const startsOk = r.start === null || r.start.getTime() <= now;
    const endsOk = r.end === null || r.end.getTime() > now;
    if (startsOk && endsOk) occupiedPens.add(p.pen_feature_id);
  }
  const alreadyScheduled = new Set((existing ?? []).map((s) => s.pen_feature_id));
  const pens = [...occupiedPens].filter((pen) => !alreadyScheduled.has(pen));

  if (pens.length === 0) {
    return {
      status: 'error',
      message: 'Every pen with cattle already has a schedule, or no pen holds a group right now.',
    };
  }

  const rows = pens.map((pen) => ({
    org_id: farm.org_id,
    farm_id: farmId,
    pen_feature_id: pen,
    windows: [
      { time: '06:00', days: EVERY_DAY },
      { time: '17:00', days: EVERY_DAY },
    ],
    grace_minutes: 60,
    active: true,
  }));

  const { error } = await supabase.from('feed_schedules').insert(rows);
  if (error) {
    return { status: 'error', message: 'Setting a schedule needs a manager or the owner.' };
  }

  revalidatePath(`/farms/${farmId}/feed`);
  return {
    status: 'saved',
    message: `Schedule set: 06:00 and 17:00 for ${pens.length} ${pens.length === 1 ? 'pen' : 'pens'}.`,
  };
}
