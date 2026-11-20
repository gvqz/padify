import { expect, test, type Page } from '@playwright/test';

/**
 * The offline story — the network's state is visible, and offline never
 * reads as broken.
 *
 * The chip: the status bar flags a missing network the way it flags a
 * save. The cloud panel: offline, the sign-in form stands down and an
 * honest notice takes its place — the panel stops promising something
 * the network cannot deliver. The hamburger's fold rides along here
 * because the evidence shots share the run (bt21-* land in qa/evidence/).
 */

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught page errors').toEqual([]);
});

test.describe('offline', () => {
  test('the chip follows the network and the cloud panel stands the form down', async ({
    page,
  }) => {
    await page.goto('/');
    const editor = page.locator('#note');
    await expect(editor).toBeVisible();
    // Let the idle boot settle so the evidence shot shows the resting app.
    await page.waitForTimeout(600);

    // Online: no chip — and the boot note is a blank page (the welcome
    // prose left).
    const chip = page.locator('#offlineChip');
    await expect(chip).toBeHidden();
    await page.screenshot({ path: 'qa/evidence/bt21-boot-blank.png' });

    // The network leaves: the chip arrives.
    await page.context().setOffline(true);
    await expect(chip).toBeVisible();
    await page.screenshot({ path: 'qa/evidence/bt21-offline-chip.png' });

    // The cloud panel says what is true instead of pushing sign-in.
    await page.locator('#cloudNavButton').click();
    await expect(page.locator('#cloudModal')).toBeVisible();
    await expect(page.locator('#cloudOfflineNotice')).toBeVisible();
    await expect(page.locator('#cloudAuthEmail')).toBeDisabled();
    await expect(page.locator('#cloudAuthPassword')).toBeDisabled();
    await expect(page.locator('#cloudAuthSubmit')).toBeDisabled();
    await page.screenshot({ path: 'qa/evidence/bt21-cloud-offline.png' });

    // The network returns: everything hands control back.
    await page.context().setOffline(false);
    await expect(chip).toBeHidden();
    await expect(page.locator('#cloudOfflineNotice')).toBeHidden();
    await expect(page.locator('#cloudAuthEmail')).toBeEnabled();
    await expect(page.locator('#cloudAuthSubmit')).toBeEnabled();
  });

  test('the mobile hamburger folds into an X while the menu is open', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const toggle = page.locator('.navbar-toggle');
    await expect(toggle).toBeVisible();
    await page.screenshot({ path: 'qa/evidence/bt21-mobile-rest.png' });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Wait out the 350ms fold-in: the collapse controller ignores clicks
    // mid-transition (the choreography's interrupt guard), so the closing
    // click below must land on a settled menu or it is silently a no-op.
    await expect(page.locator('#navbar')).toHaveClass(/\bin\b/);
    // The first bar left home: a rotated matrix, not the identity, and
    // not "none" — the fold actually happened.
    const transform = await toggle
      .locator('.icon-bar')
      .first()
      .evaluate((el) => getComputedStyle(el).transform);
    expect(transform).not.toBe('none');
    expect(transform).not.toContain('matrix(1, 0, 0, 1, 0, 0)');
    await page.screenshot({ path: 'qa/evidence/bt21-mobile-menu-open.png' });

    await toggle.click();
    await expect(page.locator('#navbar')).not.toHaveClass(/\bin\b/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});
