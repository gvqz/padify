import { expect, test, type Page } from '@playwright/test';

/**
 * Music player smoke — the controller's DOM wiring, pinned end to end.
 *
 * The player's pure logic (queue math, state sanitization, row markup)
 * is unit-tested in src/features/music-player/*.test.ts; what only a
 * browser can prove is the wiring: the modal mounts from the navbar,
 * the anonymous home renders without an account, the tabs switch, the
 * player bar rests at "Nothing playing", and the player's persisted
 * view survives a reload through the real storage path. The API runs
 * (see playwright.config.ts) but no test here needs it — the app is
 * local-first, and the anonymous home is exactly what a signed-out
 * user sees.
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
  test('opens from the navbar and rests at "Nothing playing"', async ({ page }) => {
    await page.goto('/');
    await openPlayer(page);

    await expect(page.locator('#mpPbTitle')).toHaveText('Nothing playing');
    await expect(page.locator('#mpPbSub')).toHaveText('Search a song or connect Spotify');
  });

  test('the anonymous home renders favorites and the local playlist, signed out', async ({
    page,
  }) => {
    await page.goto('/');
    await openPlayer(page);

    await expect(page.locator('#mpFreeHome')).toBeVisible();
    await expect(page.locator('#mpAccountChipText')).toHaveText('Connect Spotify');
    await expect(page.locator('#mpFavoritesEmpty')).toBeVisible();
    await expect(page.locator('#mpPlaylistName')).toHaveText('My Playlist');
    // A fresh profile has no playlist yet — rename/clear stay hidden.
    await expect(page.locator('#mpPlaylistRename')).toBeHidden();
    await expect(page.locator('#mpPlaylistClear')).toBeHidden();
  });

  test('tabs switch music → queue → ambience and back', async ({ page }) => {
    await page.goto('/');
    await openPlayer(page);

    await expect(page.locator('#mpMusicView')).toBeVisible();

    await page.locator('#mpTabQueue').click();
    await expect(page.locator('#mpQueueView')).toBeVisible();
    await expect(page.locator('#mpMusicView')).toBeHidden();
    await expect(page.locator('#mpQueueEmpty')).toBeVisible();
    await expect(page.locator('#mpQueueClear')).toBeHidden(); // nothing to clear

    await page.locator('#mpTabAmbience').click();
    await expect(page.locator('#mpAmbienceView')).toBeVisible();
    await expect(page.locator('#mpQueueView')).toBeHidden();

    await page.locator('#mpTabMusic').click();
    await expect(page.locator('#mpMusicView')).toBeVisible();
  });

  test('the last open tab survives a reload through the real storage path', async ({ page }) => {
    await page.goto('/');
    await openPlayer(page);

    await page.locator('#mpTabQueue').click();
    await expect(page.locator('#mpQueueView')).toBeVisible();
    await page.reload();

    // The modal does not auto-reopen after a reload — open it and land
    // where the user left off.
    await openPlayer(page);
    await expect(page.locator('#mpQueueView')).toBeVisible();
    await expect(page.locator('#mpTabQueue')).toHaveAttribute('aria-selected', 'true');
  });

  test('the debug probe reports a resting, signed-out player', async ({ page }) => {
    await page.goto('/');
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
    expect(snapshot.spotify).toMatchObject({ connected: false, product: null, mode: null });
  });
});
