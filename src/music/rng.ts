/**
 * Deterministic PRNG helpers for the generative music engine.
 *
 * The engine needs random decisions that are *pure functions of the slot
 * index* so that seeking works naturally: the same beat of the same track
 * always produces the same events, no matter when (or how often) it is
 * scheduled. Two utilities are provided:
 *
 *  - `mulberry32(seed)`  — classic small-state PRNG factory (streams, art).
 *  - `hashRand(seed, salt, index)` — stateless hash: deterministic float in
 *    [0, 1) for a (seed, salt, index) triple, used by the per-slot scheduler.
 */

/** Mulberry32 — small, fast, good-enough 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function next(): number {
        a = (a + 0x6d2b79f5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Stateless deterministic hash → float in [0, 1).
 * Same (seed, salt, index) always returns the same value, which makes every
 * generated pattern a pure function of absolute beat/slot position.
 */
export function hashRand(seed: number, salt: number, index: number): number {
    let h = seed | 0;
    h = Math.imul(h ^ (salt + 0x9e3779b9), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h ^ (index + 0x165667b1), 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h, 0x27d4eb2f);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}
