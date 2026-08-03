import { test, expect } from '@playwright/test';

// Phase 5 smoke: the farm ops screens exist behind the auth gate. Without a
// session the middleware sends every farm-scoped route to sign-in — proving
// the routes resolve (no 404) and stay protected.
const FARM_ID = '22222222-2222-4222-8222-222222222222';

for (const screen of ['feed', 'water', 'movement'] as const) {
  test(`unauthenticated /${screen} redirects to sign-in`, async ({ page }) => {
    await page.goto(`/farms/${FARM_ID}/${screen}`);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
}
