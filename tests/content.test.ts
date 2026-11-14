import { describe, expect, it } from 'vitest';
import { ABILITIES } from '../src/abilities';
import { ACHIEVEMENTS } from '../src/achievements';
import { CLASSES } from '../src/classes';
import { DAILY_MODS, dailyFor } from '../src/daily';
import { CARDS, ENDLESS_CARDS, KEYSTONES, RELICS, WEAPONS, baseUpgrades } from '../src/data';
import { MAPS } from '../src/maps';
import { draw, reseed } from '../src/rng';

describe('content wiring', () => {
  it('every class names a real weapon, two real abilities, and an unlock that exists', () => {
    const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
    for (const c of CLASSES) {
      expect(WEAPONS[c.weapon]).toBeDefined();
      for (const a of c.abilities) expect(ABILITIES[a]).toBeDefined();
      if (c.unlock) expect(ids.has(c.unlock)).toBe(true);
      const u = baseUpgrades();
      c.apply(u);
      expect(u.maxHp).toBeGreaterThan(0);
    }
  });

  it('relic unlocks and map unlocks point at things that exist', () => {
    const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
    for (const r of RELICS) if (r.unlock) expect(ids.has(r.unlock)).toBe(true);
    for (const m of MAPS) if (m.unlock) expect(MAPS.some((o) => o.id === m.unlock)).toBe(true);
  });

  it('card ids are unique across ordinary, keystone and endless boons', () => {
    const all = [...CARDS, ...KEYSTONES, ...ENDLESS_CARDS].map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('endless boons can be taken forever', () => {
    for (const c of ENDLESS_CARDS) expect(c.max).toBe(Infinity);
  });
});

describe('daily challenge', () => {
  it('is the same for everyone on a date and changes between dates', () => {
    const a = dailyFor(new Date('2026-11-14T03:00:00Z'));
    const b = dailyFor(new Date('2026-11-14T22:00:00Z'));
    expect(a.key).toBe('2026-11-14');
    expect(b).toEqual(a);
    const days = Array.from({ length: 14 }, (_, i) => dailyFor(new Date(Date.UTC(2026, 10, 1 + i))));
    expect(new Set(days.map((d) => `${d.map.id}/${d.mod.id}`)).size).toBeGreaterThan(5);
    for (const d of days) {
      expect(MAPS).toContain(d.map);
      expect(DAILY_MODS).toContain(d.mod);
    }
  });

  it('draws come out the same after the same seed regardless of combat randomness', () => {
    reseed(dailyFor(new Date('2026-11-14')).seed);
    const first = [draw.next(), draw.next(), draw.next()];
    reseed(dailyFor(new Date('2026-11-14')).seed);
    expect([draw.next(), draw.next(), draw.next()]).toEqual(first);
  });
});
