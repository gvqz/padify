import { expect, test, type Page } from '@playwright/test';

/**
 * The mini player — the compact bar that keeps music a background thing.
 *
 * The player modal is a room you visit to FIND music; the mini bar is
 * where music LIVES while you write: it appears when a track plays and
 * the modal closes, carries the art, the title, play/pause, next and a
 * stop, and reopens the room on demand. Until this spec, that whole
 * surface had no e2e coverage — only the engine's unit tests.
 *
 * The music network is stubbed at the route layer (capabilities, search,
 * resolve, and a generated silent WAV for the stream): the catalog's
 * real upstream is neither deterministic nor guaranteed in CI, and the
 * contracts under test are the BAR's, not the catalog's. Everything
 * above the wire is the real app — rows, queue, engine, audio element.
 */

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(String(error)));
});

test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'no uncaught page errors').toEqual([]);
});

/** A valid 8-bit mono 8kHz silent WAV — the "stream" the stub serves. */
function silentWav(seconds = 6): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const data = Buffer.alloc(44 + samples);
  data.write('RIFF', 0);
  data.writeUInt32LE(36 + samples, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); // PCM
  data.writeUInt16LE(1, 22); // mono
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate, 28);
  data.writeUInt16LE(1, 32);
  data.writeUInt16LE(8, 34); // 8-bit
  data.write('data', 36);
  data.writeUInt32LE(samples, 40);
  data.fill(128, 44); // silence
  return data;
}

const TRACKS = [
  {
    id: 't1',
    uri: 'spotify:track:t1',
    name: 'Focus Streams',
    artists: [{ name: 'The Queue' }],
    album: {},
    duration_ms: 6000,
    preview_url: null,
  },
  {
    id: 't2',
    uri: 'spotify:track:t2',
    name: 'Second Wind',
    artists: [{ name: 'The Queue' }],
    album: {},
    duration_ms: 6000,
    preview_url: null,
  },
];

/** Stubs the music wire: capabilities on, a two-track catalog, a silent
 *  stream. Returns the stream URL the resolve stub hands out. */
async function stubMusicWire(page: Page): Promise<string> {
  const streamUrl = 'http://127.0.0.1:5199/__test-audio/silence.wav';
  await page.route('**/api/music/capabilities', (route) =>
    route.fulfill({ json: { search: true, resolve: true } }),
  );
  await page.route('**/api/music/search**', (route) => route.fulfill({ json: { tracks: TRACKS } }));
  await page.route('**/api/music/resolve**', (route) =>
    route.fulfill({ json: { url: streamUrl, videoId: 'v-test', durationSec: 6, cached: false } }),
  );
  await page.route(streamUrl, (route) =>
    route.fulfill({ body: silentWav(), contentType: 'audio/wav' }),
  );
  return streamUrl;
}

async function openPlayer(page: Page): Promise<void> {
  await page.locator('a[data-target="#musicPlayerModal"]').click();
  await expect(page.locator('#musicPlayerModal')).toHaveClass(/in/);
}

test.describe('the mini player', () => {
  test('a track that plays while the modal closes lives in the bar — and the bar keeps working', async ({
    page,
  }) => {
    await stubMusicWire(page);
    await page.goto('/');
    await openPlayer(page);

    // Find a track — the stub's two-song catalog answers.
    await page.locator('#mpSearchInput').fill('focus');
    await expect(page.locator('#mpResults .sp-row')).toHaveCount(2);

    // Play the first: the player bar dresses playing, the modal is the
    // room the music was found in.
    await page.locator('#mpResults .sp-row-main').first().click();
    await expect(page.locator('#mpPlayerBar')).toHaveClass(/is-playing/);

    // Close the room — the music keeps playing in the bar.
    await page.keyboard.press('Escape');
    await expect(page.locator('#musicPlayerModal')).not.toHaveClass(/in/);
    const mini = page.locator('#mpMiniPlayer');
    await expect(mini).toBeVisible();
    await expect(mini).toHaveClass(/is-playing/);
    await expect(page.locator('#mpMiniTitle')).toHaveText('Focus Streams');
    await expect(page.locator('#mpMiniSub')).toHaveText('The Queue');

    // Next, from the bar — the queue advances without the room.
    await page.locator('#mpMiniNext').click();
    await expect(page.locator('#mpMiniTitle')).toHaveText('Second Wind');
    await expect(mini).toHaveClass(/is-playing/);

    // Pause and resume, from the bar.
    await page.locator('#mpMiniPlay').click();
    await expect(mini).not.toHaveClass(/is-playing/);
    await page.locator('#mpMiniPlay').click();
    await expect(mini).toHaveClass(/is-playing/);

    // The bar reopens the room on demand — and stands down while it is
    // open (two surfaces playing the same track would be a duet nobody
    // asked for).
    await page.locator('#mpMiniOpen').click();
    await expect(page.locator('#musicPlayerModal')).toHaveClass(/in/);
    await expect(mini).toBeHidden();
    await expect(page.locator('#mpPbTitle')).toHaveText('Second Wind');

    // Close the room again — the bar comes back.
    await page.keyboard.press('Escape');
    await expect(mini).toBeVisible();

    // The bar's × stops and hides: nothing playing, no bar.
    await page.locator('#mpMiniClose').click();
    await expect(mini).toBeHidden();
    await openPlayer(page);
    await expect(page.locator('#mpPbTitle')).toHaveText('Nothing playing');
  });
});
