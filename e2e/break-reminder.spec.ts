/**
 * Break reminder — the notes-rail popup.
 *
 * The popup must dock ABOVE the "+ New note" split control (its long-term
 * home; the mini music player joins it later), and every control on it
 * must actually work. Regression context for this spec: the buttons were
 * bound at module-evaluation time to markup that mountModals() only mounts
 * at boot — four dead listeners on empty collections, so Take break,
 * Snooze, Dismiss and the close button did nothing — and the popup sat ON
 * the New note button (fixed bottom-left) instead of above it.
 */
import { expect, test, type Page } from '@playwright/test';

/** Enables reminders through the real setting path (the preferences checkbox). */
async function enableReminders(page: Page): Promise<void> {
  await page.evaluate(() => {
    const checkbox = document.getElementById('breakReminders') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/**
 * Toggles the setting off→on. Disabling clears the persisted session state
 * (snooze/dismiss windows, accumulated writing time), so each act starts
 * from a clean reminder session without waiting out a cooldown.
 */
async function resetReminderSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const checkbox = document.getElementById('breakReminders') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** Writes long enough to cross the threshold, then waits for the popup. */
async function writeUntilReminderShows(page: Page): Promise<void> {
  await resetReminderSession(page);
  const editor = page.locator('#note');
  await editor.click();

  for (let i = 0; i < 8; i++) {
    await page.keyboard.type(`x${i} `);
    await page.waitForTimeout(600);
    if (
      await page.evaluate(() =>
        document.getElementById('breakReminderPopup')?.classList.contains('show'),
      )
    ) {
      break;
    }
  }

  const popup = page.locator('#breakReminderPopup');
  await expect(popup).toHaveClass(/show/, { timeout: 5_000 });
  // The entrance animation runs 0.5s — let it settle before clicking around.
  await page.waitForTimeout(600);
}

test.describe('break reminder popup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await enableReminders(page);
  });

  test('docks above the New note button and matches its footprint', async ({ page }) => {
    await writeUntilReminderShows(page);

    const geometry = await page.evaluate(() => {
      const popup = document.getElementById('breakReminderPopup')!.getBoundingClientRect();
      const anchor = document.querySelector('.tab-rail-add-group')!.getBoundingClientRect();
      return {
        gap: anchor.top - popup.bottom,
        leftDelta: Math.abs(popup.left - anchor.left),
        widthDelta: Math.abs(popup.width - anchor.width),
        coversButton: popup.bottom > anchor.top && popup.top < anchor.bottom,
      };
    });

    // Docked above the foot's New note control, clear of its top border
    // line (the 14px gap plus the foot's 10px padding), same footprint.
    expect(geometry.gap).toBeGreaterThanOrEqual(20);
    expect(geometry.gap).toBeLessThanOrEqual(28);
    expect(geometry.leftDelta).toBeLessThanOrEqual(1);
    expect(geometry.widthDelta).toBeLessThanOrEqual(1);
    expect(geometry.coversButton).toBe(false);

    // The offer copy is the pitched one, not the old 2-minute phrasing.
    await expect(page.locator('#breakReminderTitle')).toHaveText('Time for a quick break?');
    await expect(page.locator('#dismissBreakAction')).toHaveCount(0); // removed — the × closes
    await expect(page.locator('#snoozeBreakAction')).toBeVisible();

    // The popup is a rail SECTION: it lives inside the rail, over the
    // same surface, not a floating card hovering over the list.
    const parented = await page.evaluate(() => {
      const popup = document.getElementById('breakReminderPopup');
      const rail = document.getElementById('tabRail');
      const railBg = rail ? getComputedStyle(rail).backgroundColor : '';
      const popupBg = popup ? getComputedStyle(popup).backgroundColor : '';
      return { inRail: !!popup && !!rail && rail.contains(popup), railBg, popupBg };
    });
    expect(parented.inRail).toBe(true);
    expect(parented.popupBg).toBe(parented.railBg);
  });

  test('Take break starts the countdown; Back to writing ends it', async ({ page }) => {
    await writeUntilReminderShows(page);

    await page.locator('#takeBreakAction').click();

    // The card flips into the countdown state behind the calming veil.
    await expect(page.locator('#breakReminderPopup')).toHaveClass(/break-active/);
    await expect(page.locator('#breakReminderTitle')).toHaveText(/0[12]:\d{2}/);
    await expect(page.locator('#breakReminderText')).toHaveText(
      'Relax your eyes. Unclench your jaw. Breathe.',
    );
    await expect(page.locator('#breakVeil')).toHaveClass(/active/);
    await expect(page.locator('#snoozeBreakAction')).toBeHidden();

    await page.locator('#takeBreakAction').click();

    // Back to writing: the veil lifts and the card slides away.
    await expect(page.locator('#breakVeil')).not.toHaveClass(/active/);
    await expect(page.locator('#breakReminderPopup')).toHaveClass(
      /^toast-popup break-reminder-popup$/,
      {
        timeout: 3_000,
      },
    );
  });

  test('Snooze closes the popup and parks the reminder', async ({ page }) => {
    await writeUntilReminderShows(page);

    await page.locator('#snoozeBreakAction').click();

    await expect(page.locator('#breakReminderPopup')).toHaveClass(
      /^toast-popup break-reminder-popup$/,
      {
        timeout: 3_000,
      },
    );
    const parked = await page.evaluate(
      () => JSON.parse(localStorage.getItem('breakReminderState') || '{}').snoozedUntil,
    );
    expect(parked).toBeGreaterThan(Date.now());
  });

  test('the close button dismisses with a cooldown', async ({ page }) => {
    await writeUntilReminderShows(page);

    await page.locator('#closeBreakReminderPopup').click();

    await expect(page.locator('#breakReminderPopup')).toHaveClass(
      /^toast-popup break-reminder-popup$/,
      {
        timeout: 3_000,
      },
    );
    const state = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('breakReminderState') || '{}'),
    );
    expect(state.dismissedUntil).toBeGreaterThan(Date.now());
  });

  test('mobile: rides the rail — hidden with the closed drawer, docked when open', async ({
    page,
  }) => {
    // Below the 820px breakpoint the rail is an off-canvas drawer, closed
    // by default. The popup lives INSIDE the rail now, so it is simply
    // off-screen with the drawer — no viewport-corner fallback to collide
    // with the editor.
    await page.setViewportSize({ width: 700, height: 800 });
    await writeUntilReminderShows(page);

    const closed = await page.evaluate(() => {
      const rect = document.getElementById('breakReminderPopup')!.getBoundingClientRect();
      return { onScreen: rect.right > 0 && rect.left < window.innerWidth };
    });
    expect(closed.onScreen).toBe(false);

    // Opening the drawer slides the rail in — the popup is a rail child
    // and rides the transform, docking above the New note control.
    await page.locator('#tabRailToggle').click();
    await page.waitForTimeout(600);

    const docked = await page.evaluate(() => {
      const popup = document.getElementById('breakReminderPopup')!.getBoundingClientRect();
      const anchor = document.querySelector('.tab-rail-add-group')!.getBoundingClientRect();
      return {
        onScreen: popup.right > 0 && popup.left >= 0,
        dockedAbove: Math.abs(anchor.top - popup.bottom) >= 20,
        clearOfAnchor: popup.bottom <= anchor.top,
      };
    });
    expect(docked.onScreen).toBe(true);
    expect(docked.dockedAbove).toBe(true);
    expect(docked.clearOfAnchor).toBe(true);
  });
});
