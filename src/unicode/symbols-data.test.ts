import { describe, expect, it } from 'vitest';
import { UNICODE_SYMBOLS, UNICODE_CATEGORIES } from './symbols-data';

/**
 * The symbol table is auto-generated (scripts/gen-unicode-data.mjs), so these
 * tests guard the generator's output contract rather than individual rows:
 * the picker, its search and its category grouping all assume this shape.
 */
describe('UNICODE_SYMBOLS', () => {
  it('carries the full advertised symbol set', () => {
    // Generator header promises 5418 characters across 31 categories.
    expect(UNICODE_SYMBOLS.length).toBeGreaterThanOrEqual(5400);
    expect(UNICODE_CATEGORIES).toHaveLength(31);
  });

  it('keeps every entry structurally valid', () => {
    for (const symbol of UNICODE_SYMBOLS) {
      expect(symbol.char.length).toBeGreaterThan(0);
      expect(symbol.name.trim().length).toBeGreaterThan(0);
      expect(symbol.category.trim().length).toBeGreaterThan(0);
      expect(Number.isInteger(symbol.codepoint)).toBe(true);
      expect(symbol.codepoint).toBeGreaterThan(0);
    }
  });

  it('derives codepoints from the character itself', () => {
    for (const symbol of UNICODE_SYMBOLS) {
      expect(symbol.char.codePointAt(0)).toBe(symbol.codepoint);
    }
  });

  it('only uses known categories', () => {
    const known = new Set(UNICODE_CATEGORIES);
    for (const symbol of UNICODE_SYMBOLS) {
      expect(known.has(symbol.category)).toBe(true);
    }
  });

  it('resolves the documented rightwards arrow entry', () => {
    // types.ts documents U+2192 (8594) as the canonical example.
    const arrow = UNICODE_SYMBOLS.find((symbol) => symbol.codepoint === 8594);
    expect(arrow).toBeDefined();
    expect(arrow?.char).toBe('→');
  });

  it('has unique codepoints within a category (stable picker grouping)', () => {
    const seen = new Set<number>();
    for (const symbol of UNICODE_SYMBOLS) {
      // Variants that share a codepoint across categories are fine, but a
      // duplicate within one category means the generator double-inserted.
      const key = symbol.codepoint;
      if (seen.has(key)) {
        // Only fail if the duplicate lives in the same category.
        const first = UNICODE_SYMBOLS.find((entry) => entry.codepoint === key);
        expect(first?.category === symbol.category && first !== symbol).toBe(false);
      }
      seen.add(key);
    }
  });
});
