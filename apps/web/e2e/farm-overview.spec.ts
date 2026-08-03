import { test, expect } from '@playwright/test';

// Phase 5: the farm overview and pen detail resolve and stay behind the auth
// gate. Without a session the middleware sends every farm-scoped route to
// sign-in, which proves the route exists (a 404 would not redirect) and that
// nothing on it leaks to an anonymous visitor.
const FARM_ID = '22222222-2222-4222-8222-222222222222';
const PEN_ID = '36fd0c59-0e34-42d0-8dbd-199ba2d22e5b';

const ROUTES = [
  { name: 'farm overview', path: `/farms/${FARM_ID}` },
  { name: 'pen detail', path: `/farms/${FARM_ID}/pens/${PEN_ID}` },
];

for (const route of ROUTES) {
  test(`unauthenticated ${route.name} redirects to sign-in`, async ({ page }) => {
    await page.goto(route.path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
}

// The Telemetry Rail is farm-scoped: it must not appear on non-farm routes.
// Sign-in is outside the (app) shell entirely, so the rail's landmark is absent.
test('rail does not render outside farm routes', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('complementary', { name: 'Live farm numbers' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Live farm numbers' })).toHaveCount(0);
});
