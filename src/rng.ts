/**
 * Seeded random numbers for everything that affects play, so a daily run is the same for everyone.
 * Cosmetic effects keep using Math.random.
 */
let state = (Math.random() * 0xffffffff) >>> 0;

export function reseed(seed: number): void { state = seed >>> 0; }

/** The generator's current state, so a saved run can continue the same sequence. */
export function rngState(): number { return state; }

/** mulberry32: small, fast and good enough for a game. */
export function rand(): number {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];

/** Shuffles in place and returns the list. */
export function shuffle<T>(list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** FNV-1a, for turning a date or name into a seed. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
