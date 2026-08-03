import { test, expect } from '@playwright/test';

// Phase 1 smoke: unauthenticated visitors land on sign-in and the page
// renders its heading and action.
test('root redirects to sign-in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Send sign-in link' }),
  ).toBeVisible();
});
