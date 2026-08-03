// A small synthetic farm, shaped exactly like `readLayout` returns, so the
// behaviour tests never touch the network.

import type { Feature, FeatureKind, Layout } from '../src/layout.ts';

function feature(id: string, name: string, kind: FeatureKind, lon: number, lat: number): Feature {
  return { id, name, kind, area_m2: kind === 'gate' ? null : 3000, capacity_head: null, centroid: [lon, lat] };
}

export const PEN_A = '11111111-aaaa-4aaa-8aaa-000000000001';
export const PEN_B = '11111111-aaaa-4aaa-8aaa-000000000002';
export const PEN_C = '11111111-aaaa-4aaa-8aaa-000000000003';
export const LANE = '22222222-bbbb-4bbb-8bbb-000000000001';
export const GATE_1 = '33333333-cccc-4ccc-8ccc-000000000001';
export const GATE_2 = '33333333-cccc-4ccc-8ccc-000000000002';
export const GATE_3 = '33333333-cccc-4ccc-8ccc-000000000003';
export const BUILDING = '44444444-dddd-4ddd-8ddd-000000000001';

export function testLayout(overrides: Partial<Layout> = {}): Layout {
  const features = new Map<string, Feature>();
  const add = (f: Feature): void => {
    features.set(f.id, f);
  };
  add(feature(PEN_A, 'North Lot', 'pen', -111.8256, 39.0717));
  add(feature(PEN_B, 'Small Pen 7', 'pen', -111.8271, 39.068));
  add(feature(PEN_C, 'Big Pasture', 'pen', -111.83, 39.075));
  add(feature(LANE, 'Feed Lane 2', 'feed_lane', -111.8258, 39.0719));
  add(feature(GATE_1, 'Gate', 'gate', -111.8257, 39.0718));
  add(feature(GATE_2, 'Gate', 'gate', -111.8259, 39.0715));
  add(feature(GATE_3, 'Gate', 'gate', -111.8272, 39.0681));
  add(feature(BUILDING, 'Barn(HQ)', 'building', -111.826, 39.072));

  const featuresByKind = new Map<FeatureKind, Feature[]>();
  for (const f of features.values()) {
    const list = featuresByKind.get(f.kind) ?? [];
    list.push(f);
    featuresByKind.set(f.kind, list);
  }
  for (const list of featuresByKind.values()) list.sort((a, b) => a.id.localeCompare(b.id));

  const base: Layout = {
    farm: {
      id: '22222222-2222-4222-8222-222222222222',
      org_id: '11111111-1111-4111-8111-111111111111',
      name: 'Test Ranch',
      timezone: 'America/Denver',
      webhook_token: 'a'.repeat(48),
    },
    credentials: {
      farm_id: '22222222-2222-4222-8222-222222222222',
      webhook_uuid: 'd1c7e418-e204-451e-b04b-7dec722db777',
      webhook_secret: 'test-secret-not-a-real-one',
    },
    features,
    featuresByKind,
    devices: [],
    feedSchedules: [
      {
        id: '55555555-eeee-4eee-8eee-000000000001',
        pen_feature_id: PEN_A,
        group_id: null,
        target_kg: 1400,
        windows: [{ time: '06:00' }, { time: '17:00' }],
        grace_minutes: 60,
        active: true,
      },
      {
        id: '55555555-eeee-4eee-8eee-000000000002',
        pen_feature_id: PEN_B,
        group_id: null,
        target_kg: 300,
        windows: [{ time: '06:00' }, { time: '17:00' }],
        grace_minutes: 60,
        active: true,
      },
    ],
    stockedPens: [
      {
        penFeatureId: PEN_A,
        penName: 'North Lot',
        groupId: 'aaaa1111-1111-4111-8111-111111111111',
        groupName: 'North lot steers',
        headCount: 237,
        avgWeightKg: 295,
        species: 'cattle',
      },
      {
        penFeatureId: PEN_B,
        penName: 'Small Pen 7',
        groupId: 'bbbb1111-1111-4111-8111-111111111111',
        groupName: 'Pen 7 heifers',
        headCount: 45,
        avgWeightKg: 320,
        species: 'cattle',
      },
    ],
  };
  return { ...base, ...overrides };
}
