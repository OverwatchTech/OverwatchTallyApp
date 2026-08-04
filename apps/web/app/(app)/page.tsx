// "/" — the farm chooser. A single-farm account never sees it: it redirects
// straight into the farm, which is what makes the bar look like the mockup for
// almost everybody. Multi-farm accounts land here, and the farm picker beside
// the brand mark does the same job from every other screen.

import { redirect } from 'next/navigation';
import { ActivityRow, Card, Pad, PageHeader } from '@overwatch/ui';
import { createClient } from '@/lib/supabase/server';
import { formatTier } from '@/lib/format';

export default async function FarmsPage() {
  const supabase = await createClient();

  const { data: farms } = await supabase
    .from('farms')
    .select('id, name, status, subscription_tier')
    .order('name');

  const onlyFarm = farms && farms.length === 1 ? farms[0] : undefined;
  if (onlyFarm) {
    redirect(`/farms/${onlyFarm.id}`);
  }

  if (!farms || farms.length === 0) {
    return (
      <Pad>
        <Card title="No farms yet" className="max-w-[460px]">
          <p style={{ color: 'var(--ink2)', lineHeight: 1.55 }}>
            Your farm shows up here once your installer finishes setup.
          </p>
        </Card>
      </Pad>
    );
  }

  return (
    <Pad>
      <PageHeader
        title="Your farms"
        sub={
          <>
            <b>{farms.length}</b> operations on this account. Pick one to open its
            tally.
          </>
        }
      />
      <Card padded={false}>
        {farms.map((farm) => (
          <ActivityRow
            key={farm.id}
            href={`/farms/${farm.id}`}
            tone="ok"
            meta={
              <>
                {farm.status}
                {farm.subscription_tier ? ` · ${formatTier(farm.subscription_tier)}` : ''}
              </>
            }
          >
            <b>{farm.name}</b>
          </ActivityRow>
        ))}
      </Card>
    </Pad>
  );
}
