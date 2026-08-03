import { test, expect } from '@playwright/test';

// Phase 7 smoke. There is no staff session in CI, so what these prove is the
// half that matters most for an internal console: the routes exist (no 404,
// no build-time crash) and NONE of them render to an anonymous visitor.
//
// The middleware sends a signed-out request to /login; a signed-in non-staff
// user is redirected to the portal by requireStaff(). RLS is the real
// enforcement either way (CLAUDE.md #9) — these assertions cover the gate in
// front of it.
const ADMIN_ROUTES = [
  '/admin',
  '/admin/orgs',
  '/admin/ingest',
  '/admin/fleet',
  '/admin/orders',
  '/admin/install',
] as const;

for (const route of ADMIN_ROUTES) {
  test(`unauthenticated ${route} redirects to sign-in`, async ({ page }) => {
    await page.goto(route);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
}

test('farm provisioning is behind the gate', async ({ page }) => {
  await page.goto('/admin/farms/22222222-2222-4222-8222-222222222222');
  await expect(page).toHaveURL(/\/login$/);
});

test('the installer sync endpoint refuses an anonymous post', async ({ request }) => {
  const response = await request.post('/admin/install/sync', {
    multipart: { draft: JSON.stringify({ farmId: 'x', devEui: 'x' }) },
  });
  // Signed out, middleware redirects the POST to /login rather than letting it
  // reach the handler. Either way the one unacceptable outcome — a 2xx that
  // wrote a device — must not happen.
  expect(response.status()).not.toBe(200);
});

test('the installer manifest and worker sit behind the same gate', async ({ page }) => {
  // Both are session-scoped like every other /admin route. The manifest link
  // on the page carries crossOrigin="use-credentials" precisely so the
  // browser's own fetch survives this redirect; a signed-out request does not.
  await page.goto('/admin/install/manifest.webmanifest');
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/admin/install/sw.js');
  await expect(page).toHaveURL(/\/login$/);
});
