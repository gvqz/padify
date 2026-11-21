/**
 * The one color canonicalizer — the H10 pin. The picker's write side
 * (normalizeHex + rgbStringToHex) and the theme re-ink's read side
 * (canonicalizeColor) are one spelling now: a stored color the picker
 * accepts can never be one the re-ink pass refuses, and the edge forms
 * they used to disagree on are pinned here so they cannot drift apart
 * again.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeColor } from './theme-colors';
import { normalizeHex, rgbStringToHex } from './color-picker';

describe('canonicalizeColor — the picker and the re-ink pass agree', () => {
  it('hex forms: 6-digit, 3-digit, uppercase, bare', () => {
    expect(canonicalizeColor('#1a1a1a')).toBe('#1a1a1a');
    expect(canonicalizeColor('#1A1A1A')).toBe('#1a1a1a');
    expect(canonicalizeColor('#1a1')).toBe('#11aa11');
    // The old reader rejected the picker's bare-hex spelling.
    expect(canonicalizeColor('aabbcc')).toBe('#aabbcc');
  });

  it('rgb forms: proper, spaced, alpha', () => {
    expect(canonicalizeColor('rgb(26, 26, 26)')).toBe('#1a1a1a');
    expect(canonicalizeColor('rgb( 26 , 26 , 26 )')).toBe('#1a1a1a');
    expect(canonicalizeColor('rgba(26, 26, 26, 0.5)')).toBe('#1a1a1a');
  });

  it('the H10 divergence: over-range channels clamp, exactly like the picker', () => {
    // The old reader returned null here while the picker clamped — a
    // stored color only one side understood, re-inked inconsistently.
    expect(canonicalizeColor('rgb(300, 0, 0)')).toBe('#ff0000');
    expect(canonicalizeColor('rgb(300, 0, 0)')).toBe(rgbStringToHex('rgb(300, 0, 0)'));
  });

  it('junk refuses honestly', () => {
    expect(canonicalizeColor('red')).toBeNull(); // named colors are not keys
    expect(canonicalizeColor('')).toBeNull();
    expect(canonicalizeColor('#12345')).toBeNull(); // 5 digits
    expect(canonicalizeColor('#1234567')).toBeNull(); // 7 digits
    // The old reader accepted this (no closing paren in its pattern);
    // a style value the browser cannot render is not a color key.
    expect(canonicalizeColor('rgb(1, 2, 3')).toBeNull();
    expect(canonicalizeColor('rgba(1, 2, 3, 2)')).toBeNull(); // alpha > 1
  });

  it('the composition is honest: every accepted form is one the picker emits', () => {
    // The identity that matters — for ANY input, the reader and the
    // writer's normalizers answer the same thing.
    const forms = [
      '#1a1a1a',
      '#1A1',
      'aabbcc',
      'rgb(0, 0, 0)',
      'rgba(255, 255, 255, 0.25)',
      'rgb(300, 1, 1)',
      'rgb(10.5, 20, 30)',
      'nope',
    ];
    for (const form of forms) {
      expect(canonicalizeColor(form)).toBe(normalizeHex(form) ?? rgbStringToHex(form));
    }
  });
});
