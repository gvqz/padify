import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatformOverrideForTests } from '../lib/platform';
import {
  hydrateModifierKeyElements,
  hydratePlatformShortcuts,
  hydrateShortcutTitles,
} from './platform-hints';

/**
 * The hydration pass turns static-markup intent (data-mod-key, data-alt-key,
 * data-shortcut-title) into platform-correct text. Both sides of the split
 * are pinned here so neither regresses.
 */

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  setPlatformOverrideForTests(null);
});

describe('hydrateModifierKeyElements', () => {
  it('swaps the written-in Ctrl for the Apple glyphs on Apple platforms', () => {
    setPlatformOverrideForTests(true);
    document.body.innerHTML = `
      <div class="shortcut-keys"><kbd data-mod-key>Ctrl</kbd> + <kbd>S</kbd></div>
      <div class="shortcut-keys"><kbd data-alt-key>Alt</kbd> + <kbd>V</kbd></div>
    `;

    hydrateModifierKeyElements();

    expect(document.querySelector('[data-mod-key]')!.textContent).toBe('⌘');
    expect(document.querySelector('[data-alt-key]')!.textContent).toBe('⌥');
    // The non-platform key is untouched.
    expect(document.querySelectorAll('kbd')[1]!.textContent).toBe('S');
  });

  it('leaves the non-Apple spelling in place everywhere else', () => {
    setPlatformOverrideForTests(false);
    document.body.innerHTML = `<kbd data-mod-key>Ctrl</kbd> + <kbd data-alt-key>Alt</kbd>`;

    hydrateModifierKeyElements();

    expect(document.querySelector('[data-mod-key]')!.textContent).toBe('Ctrl');
    expect(document.querySelector('[data-alt-key]')!.textContent).toBe('Alt');
  });
});

describe('hydrateShortcutTitles', () => {
  it('appends the rendered shortcut to the base title', () => {
    setPlatformOverrideForTests(false);
    document.body.innerHTML = `
      <span title="Preferences" data-shortcut-title="mod+,">gear</span>
      <li title="Insert Unicode Symbol" data-shortcut-title="mod+shift+o">Ω</li>
    `;

    hydrateShortcutTitles();

    expect(document.querySelector('span')!.getAttribute('title')).toBe('Preferences [Ctrl + ,]');
    expect(document.querySelector('li')!.getAttribute('title')).toBe(
      'Insert Unicode Symbol [Ctrl + Shift + O]',
    );
  });

  it('renders the Apple spelling on Apple platforms', () => {
    setPlatformOverrideForTests(true);
    document.body.innerHTML = `<span title="Preferences" data-shortcut-title="mod+,">gear</span>`;

    hydrateShortcutTitles();

    expect(document.querySelector('span')!.getAttribute('title')).toBe('Preferences [⌘ + ,]');
  });

  it('an element without a title degrades to just the shortcut', () => {
    setPlatformOverrideForTests(false);
    document.body.innerHTML = `<span data-shortcut-title="mod+s"></span>`;

    hydrateShortcutTitles();

    expect(document.querySelector('span')!.getAttribute('title')).toBe('[Ctrl + S]');
  });
});

describe('hydratePlatformShortcuts — the boot pass', () => {
  it('covers both mechanisms in one call', () => {
    setPlatformOverrideForTests(false);
    document.body.innerHTML = `
      <kbd data-mod-key>Ctrl</kbd>
      <span title="Theme" data-shortcut-title="mod+m">moon</span>
    `;

    hydratePlatformShortcuts();

    expect(document.querySelector('[data-mod-key]')!.textContent).toBe('Ctrl');
    expect(document.querySelector('span')!.getAttribute('title')).toBe('Theme [Ctrl + M]');
  });
});
