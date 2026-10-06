import { afterEach, describe, expect, it } from 'vitest';
import {
  altKeyLabel,
  detectApplePlatform,
  isApplePlatform,
  modKeyLabel,
  setPlatformOverrideForTests,
  shiftKeyLabel,
  shortcutLabel,
} from './platform';

/**
 * The platform module is the single answer to "Ctrl or ⌘?" — these tests
 * pin the detection matrix (the UA strings that decide it), every label
 * on BOTH sides of the split, and the shortcut renderer's grammar.
 */

afterEach(() => {
  setPlatformOverrideForTests(null);
});

describe('detectApplePlatform — the UA matrix', () => {
  it('recognizes the Apple platforms', () => {
    expect(detectApplePlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(
      true,
    );
    expect(
      detectApplePlatform('iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'),
    ).toBe(true);
    expect(detectApplePlatform('iPad', 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X)')).toBe(true);
    // An iPad in desktop mode reports a Mac platform.
    expect(detectApplePlatform('MacIntel', 'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X)')).toBe(
      true,
    );
    expect(
      detectApplePlatform('iPod', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X)'),
    ).toBe(true);
  });

  it('non-Apple platforms answer false', () => {
    expect(detectApplePlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(detectApplePlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
    expect(detectApplePlatform('', 'Mozilla/5.0 (Android 14; Mobile)')).toBe(false);
    expect(detectApplePlatform('', '')).toBe(false);
  });

  it('a Mac-flavoured UA alone still counts (platform string may be empty)', () => {
    expect(detectApplePlatform('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true);
  });
});

describe('labels — both sides of the platform split', () => {
  it('Apple spells use the symbol set', () => {
    setPlatformOverrideForTests(true);
    expect(modKeyLabel()).toBe('⌘');
    expect(altKeyLabel()).toBe('⌥');
    expect(shiftKeyLabel()).toBe('⇧');
    expect(isApplePlatform()).toBe(true);
  });

  it('everything else spells the word out', () => {
    setPlatformOverrideForTests(false);
    expect(modKeyLabel()).toBe('Ctrl');
    expect(altKeyLabel()).toBe('Alt');
    expect(shiftKeyLabel()).toBe('Shift');
    expect(isApplePlatform()).toBe(false);
  });
});

describe('shortcutLabel — the one renderer for prose hints', () => {
  it('non-Apple rendering', () => {
    setPlatformOverrideForTests(false);
    expect(shortcutLabel('mod+s')).toBe('Ctrl + S');
    expect(shortcutLabel('mod+shift+o')).toBe('Ctrl + Shift + O');
    expect(shortcutLabel('mod+,')).toBe('Ctrl + ,');
    expect(shortcutLabel('alt+v')).toBe('Alt + V');
    expect(shortcutLabel('mod+alt+arrowleft')).toBe('Ctrl + Alt + arrowleft');
  });

  it('Apple rendering', () => {
    setPlatformOverrideForTests(true);
    expect(shortcutLabel('mod+s')).toBe('⌘ + S');
    expect(shortcutLabel('mod+shift+o')).toBe('⌘ + ⇧ + O');
    expect(shortcutLabel('alt+v')).toBe('⌥ + V');
  });

  it('accepts the alias spellings and ignores empty tokens', () => {
    setPlatformOverrideForTests(false);
    expect(shortcutLabel('ctrl+b')).toBe('Ctrl + B');
    expect(shortcutLabel('cmd+b')).toBe('Ctrl + B');
    expect(shortcutLabel('command+b')).toBe('Ctrl + B');
    expect(shortcutLabel('option+v')).toBe('Alt + V');
    expect(shortcutLabel('mod++x')).toBe('Ctrl + X');
  });
});
