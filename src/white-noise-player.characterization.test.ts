/**
 * Characterization suite for the ambience mixer (src/white-noise-player.ts)
 * — the 12 sound buttons, the global mute/stop pair, and the preset menu
 * that persists mixes under the raw kv key `ambient-noise-presets`.
 *
 * What this pins, and why it matters:
 *  - the module accessor lifecycle Task 2 introduced: getWhiteNoisePlayer()
 *    answers null until initWhiteNoisePlayer() runs (and only then — after
 *    storageReady() — because the constructor loads persisted presets);
 *  - the sound lifecycle: a button click lazily creates the looped <audio>,
 *    plays it at the slider's volume, paints the button, and shows the
 *    global mute/stop pair; toggling off pauses exactly that sound;
 *  - pauseAll vs stopAll semantics (stopAll additionally rewinds to 0:00);
 *  - preset persistence: create/rename/delete/apply write through stateSet
 *    on `ambient-noise-presets` with slider values stored as 0–100 ints
 *    (NOT the 0–1 audio volume), and a manual mix edit demotes the active
 *    preset back to "Custom";
 *  - the global mute toggle lives OUTSIDE the class — initWhiteNoisePlayer
 *    wires it, which is why a bare constructor cannot mute.
 *
 * jsdom never actually decodes media, so HTMLMediaElement.load is stubbed to
 * fire `canplaythrough` synchronously (the success path) and play/pause are
 * stubbed as resolved/no-op — the app's audio state machine is what's under
 * test, not the codec.
 *
 * Everything here was written against the behaviour of the live app at the
 * commit this file landed. If a test fails after an intentional behavior
 * change, update the test in the same commit and say why in the message.
 */
import 'fake-indexeddb/auto';
import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { SweetAlertResult } from 'sweetalert2';

// Swal is modal UI — mocked so prompt/confirm flows can be driven. isVisible
// is read by the preset menu's Escape handler; getInput by the prompt's
// didOpen (never called by the mock, kept for shape parity).
vi.mock('sweetalert2', () => ({
  default: {
    // The full SweetAlertResult shape: typed callers (Swal.fire generics)
    // read isDenied/isDismissed even when the flows under test only check
    // isConfirmed.
    fire: vi.fn(() => Promise.resolve({ isConfirmed: false, isDenied: false, isDismissed: true })),
    isVisible: vi.fn(() => false),
    getInput: vi.fn(() => null),
  },
}));

import Swal from 'sweetalert2';
import { WhiteNoisePlayer, getWhiteNoisePlayer, initWhiteNoisePlayer } from './white-noise-player';
import { stateGet, stateSet, resetStorageForTests, storageReady } from './storage';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

let playSpy: MockInstance<() => Promise<void>>;
let pauseSpy: MockInstance<() => void>;
let loadSpy: MockInstance<() => void>;

/** The 12 ambient sounds and their default slider values (markup.ts parity). */
const SOUND_DEFAULTS: Readonly<Record<string, number>> = {
  'winter-morning': 60,
  'suburban-street': 70,
  rain: 15,
  'rain-on-leaves': 70,
  thunder: 70,
  fireside: 60,
  crickets: 70,
  'rain-on-umbrella': 70,
  'wind-chimes': 20,
  clock: 30,
  'ceiling-fan': 80,
  underwater: 60,
};

/**
 * The ambience corner of the music modal the player queries: the sound
 * buttons (each with its volume slider, ids `<key>-volume`), the preset
 * dropdown and the global mute/stop pair. Mirrors features/music-player/
 * markup.ts selectors.
 */
function mountAmbienceDom(): void {
  document.body.innerHTML = `
    <div id="musicPlayerModal" class="modal"></div>
    <span class="ambient-noise-icon" id="ambientNoiseIcon"></span>
    <div class="sound-controls">
      <button type="button" id="globalMuteButton" title="Mute all sounds">
        <svg id="globalPlayingIcon"></svg>
        <svg id="globalMuteIcon" style="display: none"></svg>
      </button>
      <button type="button" id="globalStopButton" title="Stop all sounds"></button>
    </div>
    <span class="ambient-noise-header-actions">
      <span class="ambient-noise-presets-dropdown">
        <button type="button" id="ambientNoisePresetToggle" aria-expanded="false">
          <span id="ambientNoisePresetLabel">Custom</span>
        </button>
        <div id="ambientNoisePresetMenu" hidden>
          <div id="ambientNoisePresetList"></div>
          <div id="ambientNoisePresetEmpty">No presets yet</div>
          <button type="button" id="createAmbientNoisePreset"><span>New Preset</span></button>
        </div>
      </span>
    </span>
    <div id="ambienceSounds">
      ${Object.entries(SOUND_DEFAULTS)
        .map(
          ([key, volume]) => `
        <div class="sound-button" data-sound="${key}">
          <div class="sound-button-main"><span>${key}</span></div>
          <div class="volume-control">
            <input type="range" min="0" max="100" value="${volume}" class="volume-slider" id="${key}-volume" aria-label="${key} volume">
          </div>
        </div>`,
        )
        .join('')}
    </div>
  `;
}

/** Deletes the padify database so every test starts from an empty store. */
async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('padify');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** A storage boot from truly nothing — kv mirror AND localStorage wiped. */
async function freshBoot(): Promise<void> {
  resetStorageForTests();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await deleteDatabase();
  localStorage.clear();
  await storageReady();
}

/** The mock's confirmed-prompt shape, as sweetalert2 would resolve it. */
function confirmedPrompt(value: string): SweetAlertResult {
  return { isConfirmed: true, value } as SweetAlertResult;
}

function click(selector: string): void {
  document.querySelector(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function presetMenu(): HTMLElement {
  return document.getElementById('ambientNoisePresetMenu')!;
}

function presetLabel(): HTMLElement {
  return document.getElementById('ambientNoisePresetLabel')!;
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  playSpy = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  // jsdom's load() fires nothing — the lazy-load promise would hang forever.
  // The success path is canplaythrough, which the listeners are registered
  // for BEFORE load() runs, so a synchronous dispatch resolves the await.
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event('canplaythrough'));
  });
  vi.mocked(Swal.fire).mockReset();
  vi.mocked(Swal.fire).mockImplementation(() =>
    Promise.resolve({ isConfirmed: false, isDenied: false, isDismissed: true }),
  );
  mountAmbienceDom();
  await freshBoot();
});

afterEach(() => {
  vi.restoreAllMocks();
  // loadSpy exists for its side effect (canplaythrough dispatch); the
  // reference keeps the assignment honest for the unused-vars rule.
  void loadSpy;
});

// ---------------------------------------------------------------------------
// Module accessor lifecycle (the Task 2 seam)
// ---------------------------------------------------------------------------

describe('getWhiteNoisePlayer / initWhiteNoisePlayer (characterization)', () => {
  it('answers null before initWhiteNoisePlayer has run', () => {
    // Must stay the FIRST test in this file: the module-level instance is
    // write-once-ish state that no test hook resets.
    expect(getWhiteNoisePlayer()).toBeNull();
  });

  it('init constructs the instance after storage hydration and hides the global buttons', async () => {
    await initWhiteNoisePlayer();

    const player = getWhiteNoisePlayer();
    expect(player).not.toBeNull();
    expect(player).toBeInstanceOf(WhiteNoisePlayer);
    expect(Object.keys(player!.sounds).sort()).toEqual(Object.keys(SOUND_DEFAULTS).sort());
    // The global mute/stop pair starts hidden — there is nothing playing.
    expect(document.getElementById('globalMuteButton')!.style.display).toBe('none');
    expect(document.getElementById('globalStopButton')!.style.display).toBe('none');
  });

  it('the persisted-presets key is the legacy kv key, and empty storage boots no presets', () => {
    const player = new WhiteNoisePlayer();

    expect(player.presetsStorageKey).toBe('ambient-noise-presets');
    expect(player.presets).toEqual({});
  });

  it('corrupted preset JSON degrades to no presets instead of throwing', () => {
    stateSet('ambient-noise-presets', '{not json');
    const player = new WhiteNoisePlayer();
    expect(player.presets).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Sound lifecycle — buttons, lazy audio, volume
// ---------------------------------------------------------------------------

describe('sound buttons (characterization)', () => {
  it('a button click lazily creates the looped audio and plays it at the slider volume', async () => {
    const player = new WhiteNoisePlayer();
    const button = document.querySelector('.sound-button[data-sound="rain"]') as HTMLElement;

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(player.sounds.rain!.playing).toBe(true));

    expect(player.sounds.rain!.audio).not.toBeNull();
    expect(player.sounds.rain!.audio!.src).toContain('sounds/rain.mp3');
    expect(player.sounds.rain!.audio!.loop).toBe(true);
    expect(playSpy).toHaveBeenCalledTimes(1);
    // The slider ships at 15 (markup default) → 0.15 line level.
    expect(player.sounds.rain!.audio!.volume).toBe(0.15);
    // The button paints its playing state and the global pair appears.
    expect(button.classList.contains('playing')).toBe(true);
    expect(document.getElementById('globalMuteButton')!.style.display).toBe('block');
    expect(document.getElementById('globalStopButton')!.style.display).toBe('block');
    expect(document.querySelector('.ambient-noise-icon')!.classList.contains('is-playing')).toBe(
      true,
    );
  });

  it('a second click pauses exactly that sound and re-hides the global pair', async () => {
    const player = new WhiteNoisePlayer();
    const button = document.querySelector('.sound-button[data-sound="rain"]') as HTMLElement;

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(player.sounds.rain!.playing).toBe(true));

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(player.sounds.rain!.playing).toBe(false);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(button.classList.contains('playing')).toBe(false);
    expect(document.getElementById('globalMuteButton')!.style.display).toBe('none');
    expect(document.getElementById('globalStopButton')!.style.display).toBe('none');
    // The audio element survives (unpaused next time = instant resume).
    expect(player.sounds.rain!.audio).not.toBeNull();
  });

  it('moving the volume slider retimes the live audio volume', async () => {
    const player = new WhiteNoisePlayer();
    await player.playSound('thunder');

    const slider = document.getElementById('thunder-volume') as HTMLInputElement;
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(player.sounds.thunder!.audio!.volume).toBe(0.4);
  });

  it('pauseSound is a safe no-op on a never-loaded sound', () => {
    const player = new WhiteNoisePlayer();

    expect(() => player.pauseSound('crickets')).not.toThrow();
    expect(player.sounds.crickets!.playing).toBe(false);
    expect(pauseSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pauseAll / stopAll — the two teardown semantics
// ---------------------------------------------------------------------------

describe('pauseAll / stopAll (characterization)', () => {
  it('pauseAll pauses every playing sound but never rewinds them', async () => {
    const player = new WhiteNoisePlayer();
    await player.playSound('rain');
    await player.playSound('thunder');
    player.sounds.rain!.audio!.currentTime = 42;

    player.pauseAll();

    expect(player.sounds.rain!.playing).toBe(false);
    expect(player.sounds.thunder!.playing).toBe(false);
    expect(pauseSpy).toHaveBeenCalledTimes(2);
    // Pause keeps the position — resuming continues where it left off.
    expect(player.sounds.rain!.audio!.currentTime).toBe(42);
  });

  it('stopAll pauses AND rewinds every sound to 0:00', async () => {
    const player = new WhiteNoisePlayer();
    await player.playSound('rain');
    await player.playSound('thunder');
    player.sounds.rain!.audio!.currentTime = 42;

    player.stopAll();

    expect(player.sounds.rain!.playing).toBe(false);
    expect(player.sounds.rain!.audio!.currentTime).toBe(0);
    expect(player.sounds.thunder!.audio!.currentTime).toBe(0);
    expect(document.getElementById('globalMuteButton')!.style.display).toBe('none');
  });

  it('the global stop button (wired by init) drives stopAll', async () => {
    await initWhiteNoisePlayer();
    const player = getWhiteNoisePlayer()!;
    await player.playSound('rain');

    click('#globalStopButton');

    expect(player.sounds.rain!.playing).toBe(false);
    expect(player.sounds.rain!.audio!.currentTime).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The global mute toggle — wired by initWhiteNoisePlayer, not the class
// ---------------------------------------------------------------------------

describe('global mute (characterization)', () => {
  it('muting flips every audio element and swaps the icon pair', async () => {
    await initWhiteNoisePlayer();
    const player = getWhiteNoisePlayer()!;
    await player.playSound('rain');
    await player.playSound('thunder');

    click('#globalMuteButton');

    expect(player.sounds.rain!.audio!.muted).toBe(true);
    expect(player.sounds.thunder!.audio!.muted).toBe(true);
    expect(document.getElementById('globalMuteIcon')!.style.display).toBe('block');
    expect(document.getElementById('globalPlayingIcon')!.style.display).toBe('none');

    click('#globalMuteButton');

    expect(player.sounds.rain!.audio!.muted).toBe(false);
    expect(document.getElementById('globalMuteIcon')!.style.display).toBe('none');
    expect(document.getElementById('globalPlayingIcon')!.style.display).toBe('block');
  });
});

// ---------------------------------------------------------------------------
// Presets — persistence and the menu
// ---------------------------------------------------------------------------

describe('presets (characterization)', () => {
  it('creating a preset persists the whole mix under the legacy kv key', async () => {
    const player = new WhiteNoisePlayer();
    await player.playSound('rain');

    vi.mocked(Swal.fire).mockResolvedValueOnce(confirmedPrompt('  Focus mix  '));
    await player.createPreset();

    // The prompt's value is trimmed before it becomes a name.
    expect(player.activePresetName).toBe('Focus mix');
    expect(presetLabel().textContent).toBe('Focus mix');

    const persisted = JSON.parse(stateGet('ambient-noise-presets')!) as Record<
      string,
      { volume: number; playing: boolean }
    >;
    // Slider values persist as 0–100 integers (NOT the 0–1 audio volume),
    // and the playing flag rides along — that is what applyPreset reads.
    expect(persisted['Focus mix']).toEqual({
      ...Object.fromEntries(
        Object.keys(SOUND_DEFAULTS).map((key) => [
          key,
          { volume: SOUND_DEFAULTS[key], playing: false },
        ]),
      ),
      rain: { volume: 15, playing: true },
    });

    // The menu re-renders with the new row active and stays open.
    expect(presetMenu().hidden).toBe(false);
    const row = presetMenu().querySelector('[data-preset-name="Focus mix"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.classList.contains('active')).toBe(true);
    expect(document.getElementById('ambientNoisePresetEmpty')!.hidden).toBe(true);
  });

  it('a cancelled prompt writes nothing', async () => {
    const player = new WhiteNoisePlayer();

    vi.mocked(Swal.fire).mockResolvedValueOnce({ isConfirmed: false } as SweetAlertResult);
    await player.createPreset();

    expect(stateGet('ambient-noise-presets')).toBeNull();
    expect(player.activePresetName).toBe('');
  });

  it('an empty name after trimming is rejected — no preset, no write', async () => {
    const player = new WhiteNoisePlayer();

    vi.mocked(Swal.fire).mockResolvedValueOnce(confirmedPrompt('   '));
    await player.createPreset();

    expect(stateGet('ambient-noise-presets')).toBeNull();
  });

  it('overwriting an existing name asks first, and a refusal changes nothing', async () => {
    const original = JSON.stringify({ rain: { volume: 15, playing: false } });
    stateSet('ambient-noise-presets', JSON.stringify({ Existing: JSON.parse(original) }));
    const player = new WhiteNoisePlayer();

    // The prompt answers the existing name; the overwrite confirm refuses.
    vi.mocked(Swal.fire)
      .mockResolvedValueOnce(confirmedPrompt('Existing'))
      .mockResolvedValueOnce({ isConfirmed: false } as SweetAlertResult);
    await player.createPreset();

    expect(JSON.parse(stateGet('ambient-noise-presets')!)).toEqual({
      Existing: { rain: { volume: 15, playing: false } },
    });
    expect(player.activePresetName).toBe('');
  });

  it('applying a preset restores sliders, playing state and the label', async () => {
    stateSet(
      'ambient-noise-presets',
      JSON.stringify({
        Rainy: {
          rain: { volume: 70, playing: true },
          thunder: { volume: 50, playing: false },
        },
      }),
    );
    const player = new WhiteNoisePlayer();

    await player.applyPreset('Rainy');

    expect(player.activePresetName).toBe('Rainy');
    expect(presetLabel().textContent).toBe('Rainy');
    expect((document.getElementById('rain-volume') as HTMLInputElement).value).toBe('70');
    expect((document.getElementById('thunder-volume') as HTMLInputElement).value).toBe('50');
    expect(player.sounds.rain!.playing).toBe(true);
    expect(player.sounds.rain!.audio!.volume).toBe(0.7);
    expect(player.sounds.thunder!.playing).toBe(false);
    // Applying closes the menu.
    expect(presetMenu().hidden).toBe(true);
    // And the row is the active one.
    player.togglePresetMenu(true);
    const row = presetMenu().querySelector('[data-preset-name="Rainy"]') as HTMLElement;
    expect(row.classList.contains('active')).toBe(true);
  });

  it('applying an unknown name resets to Custom instead of throwing', async () => {
    const player = new WhiteNoisePlayer();
    player.activePresetName = 'Ghost';

    await player.applyPreset('Ghost');

    expect(player.activePresetName).toBe('');
    expect(presetLabel().textContent).toBe('Custom');
  });

  it('a manual mix edit demotes the active preset back to Custom', async () => {
    stateSet(
      'ambient-noise-presets',
      JSON.stringify({ Rainy: { rain: { volume: 70, playing: true } } }),
    );
    const player = new WhiteNoisePlayer();
    await player.applyPreset('Rainy');
    expect(player.activePresetName).toBe('Rainy');

    // The user tweaks the mix by clicking a (paused) sound on.
    const button = document.querySelector('.sound-button[data-sound="crickets"]') as HTMLElement;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(player.sounds.crickets!.playing).toBe(true));

    expect(player.activePresetName).toBe('');
    expect(presetLabel().textContent).toBe('Custom');
  });

  it('renaming moves the persisted key and the active label follows', async () => {
    stateSet(
      'ambient-noise-presets',
      JSON.stringify({ Alpha: { rain: { volume: 9, playing: false } } }),
    );
    const player = new WhiteNoisePlayer();
    await player.applyPreset('Alpha');
    expect(player.activePresetName).toBe('Alpha');

    vi.mocked(Swal.fire).mockResolvedValueOnce(confirmedPrompt('Beta'));
    await player.renamePreset('Alpha');

    expect(JSON.parse(stateGet('ambient-noise-presets')!)).toEqual({
      Beta: { rain: { volume: 9, playing: false } },
    });
    expect(player.activePresetName).toBe('Beta');
    expect(presetLabel().textContent).toBe('Beta');
  });

  it('deleting removes the preset and clears the active label', async () => {
    stateSet(
      'ambient-noise-presets',
      JSON.stringify({ Alpha: { rain: { volume: 9, playing: false } } }),
    );
    const player = new WhiteNoisePlayer();
    player.activePresetName = 'Alpha';

    vi.mocked(Swal.fire).mockResolvedValueOnce({ isConfirmed: true } as SweetAlertResult);
    await player.deletePreset('Alpha');

    expect(JSON.parse(stateGet('ambient-noise-presets')!)).toEqual({});
    expect(player.activePresetName).toBe('');
    expect(presetLabel().textContent).toBe('Custom');
    // With no presets left the empty state returns.
    expect(document.getElementById('ambientNoisePresetEmpty')!.hidden).toBe(false);
  });

  it('the menu lists presets in alphabetical order', () => {
    stateSet(
      'ambient-noise-presets',
      JSON.stringify({
        Zeta: { rain: { volume: 1, playing: false } },
        Alpha: { rain: { volume: 2, playing: false } },
        Mid: { rain: { volume: 3, playing: false } },
      }),
    );
    new WhiteNoisePlayer();

    const names = Array.from(
      document.querySelectorAll('#ambientNoisePresetList [data-preset-name]'),
    ).map((row) => (row as HTMLElement).dataset.presetName);
    expect(names).toEqual(['Alpha', 'Mid', 'Zeta']);
  });
});

// ---------------------------------------------------------------------------
// Preset menu open/close gestures
// ---------------------------------------------------------------------------

describe('preset menu gestures (characterization)', () => {
  it('the toggle opens and closes the dropdown with aria state', () => {
    // Constructed for its wiring: the constructor binds the toggle's
    // delegated listeners; the instance itself is not consulted.
    void new WhiteNoisePlayer();
    const toggle = document.getElementById('ambientNoisePresetToggle') as HTMLElement;

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(presetMenu().hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.classList.contains('open')).toBe(true);

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(presetMenu().hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('opening with no presets clears any stale active label first', () => {
    const player = new WhiteNoisePlayer();
    player.activePresetName = 'Ghost';

    player.togglePresetMenu(true);

    // Empty presets + open → the label demotes to Custom (nothing to show).
    expect(player.activePresetName).toBe('');
    expect(presetLabel().textContent).toBe('Custom');
  });

  it('Escape closes an open menu', () => {
    const player = new WhiteNoisePlayer();
    player.togglePresetMenu(true);
    expect(presetMenu().hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(presetMenu().hidden).toBe(true);
  });

  it('a click outside the dropdown closes it', () => {
    const player = new WhiteNoisePlayer();
    player.togglePresetMenu(true);

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(presetMenu().hidden).toBe(true);
  });

  it('a click inside the list on a preset row applies it (and does not close-then-open)', async () => {
    stateSet(
      'ambient-noise-presets',
      JSON.stringify({ Rainy: { rain: { volume: 70, playing: true } } }),
    );
    const player = new WhiteNoisePlayer();
    player.togglePresetMenu(true);

    const row = presetMenu().querySelector('[data-preset-name="Rainy"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(player.activePresetName).toBe('Rainy'));

    // applyPreset closes the menu itself.
    expect(presetMenu().hidden).toBe(true);
  });
});
