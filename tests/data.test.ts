import { describe, expect, it } from 'vitest';
import { CALM, ENEMIES, META, callBonus, enemyHp, interestCap, isBossWave, metaCost, waveComposition, waveOptions, xpForLevel } from '../src/data';
import { MAPS } from '../src/maps';
import { reseed } from '../src/rng';

describe('waves', () => {
  for (const map of MAPS) {
    it(`${map.id}: hordes grow and the boss comes on fives and the last wave`, () => {
      reseed(1);
      let last = 0;
      for (let w = 1; w <= map.waves; w++) {
        const comp = waveComposition(w, map, CALM);
        const foes = comp.filter((k) => k !== 'Boss').length;
        expect(foes).toBeGreaterThanOrEqual(last);
        last = foes;
        expect(comp.includes('Boss')).toBe(isBossWave(w, map));
        expect(isBossWave(w, map)).toBe(w % 5 === 0 || w === map.waves);
        for (const kind of comp) expect(ENEMIES[kind]).toBeDefined();
      }
    });

    it(`${map.id}: foes get tougher with the wave`, () => {
      for (const kind of ['Minion', 'Runner', 'Warrior', 'Hexer'] as const) {
        expect(enemyHp(kind, map.waves, map)).toBeGreaterThan(enemyHp(kind, 1, map));
      }
      expect(enemyHp('Boss', 10, map)).toBeGreaterThan(enemyHp('Boss', 5, map));
    });
  }

  it('is the same for the same seed', () => {
    reseed(42);
    const a = waveComposition(7, MAPS[0], CALM);
    reseed(42);
    expect(waveComposition(7, MAPS[0], CALM)).toEqual(a);
  });

  it('offers a steady wave and a riskier one that pays more', () => {
    reseed(3);
    const [steady, stakes] = waveOptions(6);
    expect(steady.horde).toBe(1);
    expect(steady.gold).toBe(6 + 6 * 2);
    expect(stakes.horde).toBeGreaterThan(1);
    expect(stakes.gold).toBe(stakes.boon ? 0 : 30 + 6 * 6);
  });
});

describe('formulas', () => {
  it('level thresholds rise', () => {
    expect(xpForLevel(2)).toBeGreaterThan(xpForLevel(1));
  });
  it('interest is capped by the wave', () => {
    expect(interestCap(3)).toBe(11);
  });
  it('calling a wave early pays by the second', () => {
    expect(callBonus(10, 1)).toBe(9);
    expect(callBonus(0, 5)).toBe(0);
  });
  it('meta upgrades cost more each level', () => {
    const item = META[0];
    expect(metaCost(item, 1)).toBeGreaterThan(metaCost(item, 0));
  });
});
