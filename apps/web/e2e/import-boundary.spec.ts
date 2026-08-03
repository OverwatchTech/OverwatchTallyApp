import { test, expect } from '@playwright/test';

// Phase 2 smoke: the import and boundary onboarding routes sit behind the
// auth gate like every other app surface — an unauthenticated visitor lands
// on sign-in, never on a farm surface.
test('KML import route requires sign-in', async ({ page }) => {
  await page.goto('/farms/00000000-0000-0000-0000-000000000000/import');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('boundary route requires sign-in', async ({ page }) => {
  await page.goto('/farms/00000000-0000-0000-0000-000000000000/boundary');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
