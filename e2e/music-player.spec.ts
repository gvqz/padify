import { expect, test, type Page } from '@playwright/test';

/**
 * Music player smoke — the controller's DOM wiring, pinned end to end.
 *
 * The player's pure logic (queue math, state sanitization, row markup,
 * the ambience-as-tracks engine) is unit-tested in
 * src/features/music-player/*.test.ts; what only a browser can prove is
 * the wiring: the modal mounts from the navbar, the sidebar switches the
 * five destinations, the ambience view lists the bundled sounds as
 * regular rows, the player bar rests at "Nothing playing", and the last
 * view survives a reload through the real storage path.
 *
 * Zero-console-error bar, same as the rest of the suite.
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

async function openPlayer(page: Page): Promise<void> {
  await page.locator('a[data-target="#musicPlayerModal"]').click();
  await expect(page.locator('#musicPlayerModal')).toHaveClass(/in/);
}

test.describe('music player', () => {
  test('opens from the navbar on Search and rests at "Nothing playing"', async ({ page }) => {
    await page.goto('/');
    await openPlayer(page);

    await expect(page.locator('#mpView-search')).toBeVisible();
    await expect(page.locator('#mpSearchIdle')).toBeVisible();
    await expect(page.locator('#mpPbTitle')).toHaveText('Nothing playing');
    await expect(page.locator('#mpPbSub')).toHaveText('Search a song to play');
  });

  test('the sidebar switches search → favorites → ambience → queue and back', async ({ page }) => {
    await page.goto('/');
    await openPlayer(page);

    await expect(page.locator('#mpView-search')).toBeVisible();

    await page.locator('#mpNavFavorites').click();
    await expect(page.locator('#mpView-favorites')).toBeVisible();
    await expect(page.locator('#mpView-search')).toBeHidden();
    await expect(page.locator('#mpFavoritesEmpty')).toBeVisible();

    await page.locator('#mpNavPlaylist').click();
    await expect(page.locator('#mpView-playlist')).toBeVisible();
    await expect(page.locator('#mpPlaylistName')).toHaveText('My Playlist');
    // A fresh profile has no playlist yet — rename/clear stay hidden.
    await expect(page.locator('#mpPlaylistRename')).toBeHidden();
    await expect(page.locator('#mpPlaylistClear')).toBeHidden();

    await page.locator('#mpNavAmbience').click();
    await expect(page.locator('#mpView-ambience')).toBeVisible();
    // The twelve bundled sounds, as plain track rows.
    await expect(page.locator('#mpAmbienceList .sp-row')).toHaveCount(12);
    await expect(page.locator('#mpAmbienceList .sp-row').first()).toContainText('Rain');

    await page.locator('#mpNavQueue').click();
    await expect(page.locator('#mpView-queue')).toBeVisible();
    await expect(page.locator('#mpQueueEmpty')).toBeVisible();
    await expect(page.locator('#mpQueueClear')).toBeHidden(); // nothing to clear

    await page.locator('#mpNavSearch').click();
    await expect(page.locator('#mpView-search')).toBeVisible();
  });

  test('the last open view survives a reload through the real storage path', async ({ page }) => {
    await page.goto('/');
    await openPlayer(page);

    await page.locator('#mpNavQueue').click();
    await expect(page.locator('#mpView-queue')).toBeVisible();
    // Await the reload and prove we're on the fresh document before
    // clicking again — an unawaited reload lets the next click land on the
    // old page (modal already open → no-op) and the new page never sees it.
    await page.reload();
    await expect(page.locator('#musicPlayerModal')).not.toHaveClass(/in/);

    // The modal does not auto-reopen after a reload — open it and land
    // where the user left off.
    await openPlayer(page);
    await expect(page.locator('#mpView-queue')).toBeVisible();
    await expect(page.locator('#mpNavQueue')).toHaveAttribute('aria-selected', 'true');
  });

  test('the debug probe reports a resting player', async ({ page }) => {
    await page.goto('/');
    // The player engine is a lazy chunk — the probe exists once the
    // player has been opened (see initMusicSubsystem in src/app.ts).
    await openPlayer(page);
    const snapshot = await page.evaluate(() =>
      (window as unknown as { __musicProbe: () => Record<string, unknown> }).__musicProbe(),
    );
    expect(snapshot).toMatchObject({
      source: 'none',
      freeIndex: -1,
      freeQueueLength: 0,
      shuffle: false,
      repeat: 'off',
    });
  });
});
