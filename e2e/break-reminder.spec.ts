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

/** Lowers the threshold through the dev-only hook (production keeps the
 *  real 30-minute value; tests must not depend on a shipped test value). */
async function shrinkThresholdForTest(page: Page): Promise<void> {
  await page.evaluate(() => window.__padifyBreakReminder?.setThreshold(2000));
}

/** Writes long enough to cross the threshold, then waits for the popup. */
async function writeUntilReminderShows(page: Page): Promise<void> {
  await shrinkThresholdForTest(page);
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
        fullyOnScreen:
          popup.top >= 0 &&
          popup.left >= 0 &&
          popup.right <= window.innerWidth &&
          popup.bottom <= window.innerHeight,
        coversButton: popup.bottom > anchor.top && popup.top < anchor.bottom,
      };
    });

    // Docked above the foot's New note control, clear of its top border
    // line (the 14px gap plus the foot's 10px padding), SAME footprint as
    // it — a rail-width card, not one reaching over the editor.
    expect(geometry.gap).toBeGreaterThanOrEqual(20);
    expect(geometry.gap).toBeLessThanOrEqual(28);
    expect(geometry.leftDelta).toBeLessThanOrEqual(1);
    expect(geometry.widthDelta).toBeLessThanOrEqual(1);
    expect(geometry.fullyOnScreen).toBe(true);
    expect(geometry.coversButton).toBe(false);

    // Docked mode never wears the fullscreen presentation class.
    const fullscreen = await page.evaluate(() =>
      document
        .getElementById('breakReminderPopup')!
        .classList.contains('break-reminder-fullscreen'),
    );
    expect(fullscreen).toBe(false);

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

  test('mobile: fullscreen while the drawer is closed, docked when it opens', async ({ page }) => {
    // Below the 820px breakpoint the rail is an off-canvas drawer, closed
    // by default. A docked popup would ride it out of sight — the user
    // asked for the reminder to always be findable, so the closed drawer
    // presents the card FULLSCREEN over the veil instead. Opening the
    // drawer returns it to its docked rail spot.
    await page.setViewportSize({ width: 700, height: 800 });
    await writeUntilReminderShows(page);

    const fullscreen = await page.evaluate(() => {
      const popup = document.getElementById('breakReminderPopup')!;
      const rect = popup.getBoundingClientRect();
      return {
        hasClass: popup.classList.contains('break-reminder-fullscreen'),
        inBody: popup.parentElement === document.body,
        centered: rect.top >= 0 && rect.bottom <= window.innerHeight,
        veilActive: document.getElementById('breakVeil')!.classList.contains('active'),
      };
    });
    expect(fullscreen.hasClass).toBe(true);
    expect(fullscreen.inBody).toBe(true);
    expect(fullscreen.centered).toBe(true);
    expect(fullscreen.veilActive).toBe(true);

    // Opening the drawer slides the rail in — the popup re-docks above
    // the New note control and the veil lifts.
    await page.locator('#tabRailToggle').click();
    await page.waitForTimeout(600);

    const docked = await page.evaluate(() => {
      const popup = document.getElementById('breakReminderPopup')!;
      const rect = popup.getBoundingClientRect();
      const anchor = document.querySelector('.tab-rail-add-group')!.getBoundingClientRect();
      return {
        hasClass: popup.classList.contains('break-reminder-fullscreen'),
        inRail: !!document.getElementById('tabRail')!.contains(popup),
        onScreen: rect.right > 0 && rect.left >= 0,
        dockedAbove: Math.abs(anchor.top - rect.bottom) >= 20,
        clearOfAnchor: rect.bottom <= anchor.top,
        veilActive: document.getElementById('breakVeil')!.classList.contains('active'),
      };
    });
    expect(docked.hasClass).toBe(false);
    expect(docked.inRail).toBe(true);
    expect(docked.onScreen).toBe(true);
    expect(docked.dockedAbove).toBe(true);
    expect(docked.clearOfAnchor).toBe(true);
    expect(docked.veilActive).toBe(false);
  });

  test('a viewport too small for the docked card falls back to fullscreen', async ({ page }) => {
    // A 200px-tall host window (tiny PWA/floating windows) cannot contain
    // the docked card — the reminder is re-presented fullscreen instead of
    // being clipped away.
    await page.setViewportSize({ width: 1280, height: 200 });
    await writeUntilReminderShows(page);

    const state = await page.evaluate(() => {
      const popup = document.getElementById('breakReminderPopup')!;
      const rect = popup.getBoundingClientRect();
      return {
        hasClass: popup.classList.contains('break-reminder-fullscreen'),
        insideViewport:
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.right <= window.innerWidth &&
          rect.bottom <= window.innerHeight,
        veilActive: document.getElementById('breakVeil')!.classList.contains('active'),
        actionsVisible: !!document.getElementById('takeBreakAction')!.offsetParent,
      };
    });
    expect(state.hasClass).toBe(true);
    expect(state.insideViewport).toBe(true);
    expect(state.veilActive).toBe(true);
    expect(state.actionsVisible).toBe(true);

    // Growing the window returns the card to its docked rail spot.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(400);

    const docked = await page.evaluate(() => {
      const popup = document.getElementById('breakReminderPopup')!;
      return {
        hasClass: popup.classList.contains('break-reminder-fullscreen'),
        inRail: !!document.getElementById('tabRail')!.contains(popup),
      };
    });
    expect(docked.hasClass).toBe(false);
    expect(docked.inRail).toBe(true);
  });
});
