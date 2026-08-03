// /settings/notifications — the role gate, end to end.
//
// A manager decides who gets a text at 02:00. A viewer does not. That is the
// whole claim these specs make, and they make it twice for the viewer: the
// controls are absent from the screen, AND the database refuses the write.
// The first is courtesy, the second is the enforcement (CLAUDE.md #9), and a
// suite that only checked the first would pass on a build where the policy
// had been dropped.
//
// These need credentials. Without them the whole describe SKIPS and says so —
// never a silent pass. See fixtures/README.md.

import { test, expect, clientAs, deleteRecipientsByLabel } from './fixtures/auth';
import { AUTH_ENV, SKIP_REASON } from './fixtures/env';

// Distinctive enough to find, and to clean up without touching a real contact.
const TEST_LABEL = 'E2E night man';
const TEST_PHONE = '+15005550006';
const VIEWER_LABEL = 'E2E viewer should not exist';

test.describe('notifications settings', () => {
  test.skip(!AUTH_ENV.ready, SKIP_REASON);

  // A magic link is single-use and minting a new one invalidates the last, so
  // two workers signing in as the same fixture user race each other's tokens.
  // Serial within the file, and one project only: role gating is a policy
  // question, not a viewport question, and running it twice on two viewports
  // buys nothing but a second racer.
  test.describe.configure({ mode: 'serial' });

  test.afterEach(async () => {
    if (!AUTH_ENV.ready) return;
    await deleteRecipientsByLabel(TEST_LABEL);
    await deleteRecipientsByLabel(VIEWER_LABEL);
  });

  test('a manager can add a contact', async ({ page, signInAs }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'covered once, on chromium');

    await signInAs('manager');
    await page.goto('/settings/notifications');

    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

    // The sentence the whole screen exists to keep honest.
    await expect(
      page.getByRole('heading', { name: 'Quiet hours silence the phone, not the record' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add a contact' }).click();
    await page.getByLabel('Name').fill(TEST_LABEL);
    await page.getByLabel('Phone, for texts').fill(TEST_PHONE);
    await page.getByRole('button', { name: 'Add contact' }).click();

    await expect(page.getByText(TEST_LABEL, { exact: true })).toBeVisible();
    await expect(page.getByText(TEST_PHONE)).toBeVisible();

    // The row really landed, not just the optimistic render.
    const manager = await clientAs('manager');
    const { data } = await manager
      .from('alert_recipients')
      .select('label, channel, address, enabled')
      .eq('label', TEST_LABEL);
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({ channel: 'sms', address: TEST_PHONE, enabled: true });
  });

  test('a viewer cannot add a contact', async ({ page, signInAs }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'covered once, on chromium');

    await signInAs('viewer');
    await page.goto('/settings/notifications');

    // Readable — a viewer should be able to see who gets called.
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByText('needs manager or owner access')).toBeVisible();

    // …and every control that writes is gone.
    await expect(page.getByRole('button', { name: 'Add a contact' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);

    // The gate that actually holds: RLS refuses the insert even when the form
    // is bypassed entirely.
    const viewer = await clientAs('viewer');
    const { data, error } = await viewer
      .from('alert_recipients')
      .insert({
        org_id: '11111111-1111-4111-8111-111111111111',
        label: VIEWER_LABEL,
        channel: 'sms',
        address: '+15005550007',
        escalation_tier: 0,
      })
      .select('id');

    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  test('the settings link is hidden from a viewer', async ({ page, signInAs }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'covered once, on chromium');

    await signInAs('viewer');
    await page.goto('/alerts');
    await expect(page.getByRole('link', { name: 'Alerts' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  });
});
