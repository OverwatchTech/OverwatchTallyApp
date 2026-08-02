import { test, expect } from '@playwright/test';

// Phase 0 smoke: the toolchain boots and serves a page.
// Replaced with real flows from Phase 1 on.
test('app boots and renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
});
