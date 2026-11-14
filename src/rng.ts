/**
 * Seeded random numbers for everything that affects play, so a daily run is the same for everyone.
 * Two streams: `rand` for combat (who raids, where foes spawn), which depends on how a fight goes,
 * and `draw` for choices (wave options, boons, relics, wares, chest loot), which therefore come up
 * the same for every player of a daily no matter how their fights went. Cosmetic effects keep Math.random.
 */
export class Stream {
  constructor(private state = (Math.random() * 0xffffffff) >>> 0) {}

  seed(seed: number): void { this.state = seed >>> 0; }
  get value(): number { return this.state; }

  /** mulberry32: small, fast and good enough for a game. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  pick<T>(list: readonly T[]): T { return list[Math.floor(this.next() * list.length)]; }

  /** Shuffles in place and returns the list. */
  shuffle<T>(list: T[]): T[] {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
}

const combat = new Stream();
/** The stream for choices offered to the player. */
export const draw = new Stream();

/** Seeds both streams from one number. */
export function reseed(seed: number): void {
  combat.seed(seed);
  draw.seed(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0);
}

/** Both streams' states, so a saved run can continue the same sequences. */
export function rngState(): [number, number] { return [combat.value, draw.value]; }
export function restoreRng([a, b]: [number, number]): void { combat.seed(a); draw.seed(b); }

export const rand = (): number => combat.next();
export const pick = <T>(list: readonly T[]): T => combat.pick(list);
export const shuffle = <T>(list: T[]): T[] => combat.shuffle(list);

/** FNV-1a, for turning a date or name into a seed. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
