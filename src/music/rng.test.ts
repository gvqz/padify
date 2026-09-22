import { describe, expect, it } from 'vitest';
import { hashRand, mulberry32 } from './rng';

describe('mulberry32', () => {
  it('returns floats in [0, 1)', () => {
    const next = mulberry32(42);
    for (let i = 0; i < 10_000; i++) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces different streams for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).not.toEqual(seqB);
  });

  it('spreads output across the unit interval', () => {
    const next = mulberry32(7);
    let below = 0;
    const samples = 10_000;
    for (let i = 0; i < samples; i++) {
      if (next() < 0.5) below++;
    }
    // A healthy PRNG lands near 50/50; allow a comfortable band.
    expect(below).toBeGreaterThan(samples * 0.45);
    expect(below).toBeLessThan(samples * 0.55);
  });
});

describe('hashRand', () => {
  it('returns floats in [0, 1)', () => {
    for (let index = 0; index < 1_000; index++) {
      const value = hashRand(123, 456, index);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is a pure function of (seed, salt, index)', () => {
    expect(hashRand(1, 2, 3)).toBe(hashRand(1, 2, 3));
  });

  it('varies with each input', () => {
    const base = hashRand(1, 2, 3);
    expect(hashRand(9, 2, 3)).not.toBe(base); // different seed
    expect(hashRand(1, 9, 3)).not.toBe(base); // different salt
    expect(hashRand(1, 2, 9)).not.toBe(base); // different index
  });

  it('gives distinct slots a useful spread (scheduler property)', () => {
    // The music scheduler relies on consecutive slots not collapsing to the
    // same decision — check a thousand adjacent pairs stay distinct.
    for (let index = 0; index < 1_000; index++) {
      expect(hashRand(5, 0, index)).not.toBe(hashRand(5, 0, index + 1));
    }
  });
});
