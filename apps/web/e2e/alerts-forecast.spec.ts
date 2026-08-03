import { test, expect } from '@playwright/test';

// Phase 6 smoke: the alerts and forecast screens exist behind the auth gate.
// Without a session the middleware sends both to sign-in — proving the
// routes resolve (no 404) and stay protected. Neither screen has an
// unauthenticated shape, by design: an alert names a pen and a forecast
// names a stack, and both are the customer's business alone.
const FARM_ID = '22222222-2222-4222-8222-222222222222';

test('unauthenticated /alerts redirects to sign-in', async ({ page }) => {
  await page.goto('/alerts');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('unauthenticated /forecast redirects to sign-in', async ({ page }) => {
  await page.goto(`/farms/${FARM_ID}/forecast`);
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
