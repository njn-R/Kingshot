import { describe, expect, it } from 'vitest';
import { hashString, pick, rand, reseed, rngState, shuffle } from '../src/rng';

describe('seeded random', () => {
  it('repeats the same sequence for the same seed', () => {
    reseed(123);
    const a = [rand(), rand(), rand()];
    reseed(123);
    expect([rand(), rand(), rand()]).toEqual(a);
  });

  it('stays within [0, 1) and moves its state', () => {
    reseed(9);
    const before = rngState();
    for (let i = 0; i < 1000; i++) {
      const r = rand();
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(1);
    }
    expect(rngState()).not.toBe(before);
  });

  it('shuffles in place without losing anything', () => {
    reseed(5);
    const list = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(list);
    expect(out).toBe(list);
    expect([...out].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pick(out)).toBeTypeOf('number');
  });

  it('hashes dates to stable seeds', () => {
    expect(hashString('2026-11-12')).toBe(hashString('2026-11-12'));
    expect(hashString('2026-11-12')).not.toBe(hashString('2026-11-13'));
  });
});
