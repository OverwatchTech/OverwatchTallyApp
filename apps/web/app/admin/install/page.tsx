// Installer PWA.
//
// Everything the handset needs to work with no signal is shipped in this one
// render — farms, and the map features a sensor can be mounted on — and cached
// in IndexedDB by the client. From that point the app never needs the network
// until it has something to send.
import type { Metadata, Viewport } from 'next';
import { requireStaff } from '@/lib/admin/guard';
import { recordStaffAction } from '@/lib/admin/audit';
import type { InstallContext } from '@/lib/admin/install/types';
import { InstallApp } from './install-app';
import { ServiceWorkerRegistration } from './sw-register';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Install — Overwatch Tally',
  robots: { index: false, follow: false },
  // The manifest link is rendered in the body below, not declared here: it has
  // to carry crossOrigin="use-credentials" and the Metadata API cannot express
  // that. Without it the browser fetches the manifest without cookies, the
  // middleware bounces it to sign-in, and the app is not installable.
};

export const viewport: Viewport = {
  themeColor: '#16233F',
  width: 'device-width',
  initialScale: 1,
  // The capture form is read at arm's length in daylight; pinch-zoom stays on.
  maximumScale: 5,
};

export default async function InstallPage() {
  const { supabase } = await requireStaff('installer');
  await recordStaffAction({ action: 'install.open', table: 'devices' });

  const [{ data: farms }, { data: orgs }, { data: features }] = await Promise.all([
    supabase.from('farms').select('id, name, org_id').neq('status', 'archived').order('name'),
    supabase.from('orgs').select('id, name'),
    supabase.from('map_features').select('id, farm_id, name, kind').order('name'),
  ]);

  const orgNames = new Map((orgs ?? []).map((org) => [org.id, org.name]));
  const byFarm = new Map<string, { id: string; name: string; kind: string }[]>();
  for (const feature of features ?? []) {
    const list = byFarm.get(feature.farm_id) ?? [];
    list.push({ id: feature.id, name: feature.name, kind: feature.kind });
    byFarm.set(feature.farm_id, list);
  }

  const context: InstallContext = {
    farms: (farms ?? []).map((farm) => ({
      id: farm.id,
      name: farm.name,
      orgName: orgNames.get(farm.org_id) ?? 'unknown account',
      features: byFarm.get(farm.id) ?? [],
    })),
    cachedAt: new Date().toISOString(),
  };

  return (
    <>
      <link
        rel="manifest"
        href="/admin/install/manifest.webmanifest"
        crossOrigin="use-credentials"
      />
      <ServiceWorkerRegistration />
      <InstallApp context={context} />
    </>
  );
}
