import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, decodeSave, encodeSave, fresh, migrate } from '../src/save';

describe('save migration', () => {
  it('upgrades a version 1 save without losing the treasury, upgrades or records', () => {
    const old = { version: 1, treasury: 420, meta: { heart: 2 }, best: { greenhollow: { wave: 12, won: true } }, lastMap: 'frostmere', tutorialDone: true };
    const data = migrate(old);
    expect(data.version).toBe(SAVE_VERSION);
    expect(data.treasury).toBe(420);
    expect(data.meta.heart).toBe(2);
    expect(data.best.greenhollow.won).toBe(true);
    expect(data.lastMap).toBe('frostmere');
    expect(data.tutorialDone).toBe(true);
    expect(data.history).toEqual([]);
    expect(data.achievements).toEqual(['win-greenhollow']); // old wins keep their unlocks
    expect(data.stats.runs).toBe(0);
  });

  it('starts fresh on junk and keeps what it can from a newer save', () => {
    expect(migrate(null)).toEqual(fresh());
    expect(migrate('nope')).toEqual(fresh());
    expect(migrate({ version: 0 })).toEqual(fresh());
    const future = migrate({ version: SAVE_VERSION + 5, treasury: 9, newField: true });
    expect(future.version).toBe(SAVE_VERSION);
    expect(future.treasury).toBe(9);
  });

  it('round-trips through the export string and rejects tampering', () => {
    const data = fresh();
    data.treasury = 1234;
    data.achievements.push('first-win');
    const text = encodeSave(data);
    expect(text.startsWith('PALISADE1.')).toBe(true);
    const back = decodeSave(text);
    expect(back?.treasury).toBe(1234);
    expect(back?.achievements).toEqual(['first-win']);
    const parts = text.split('.');
    expect(decodeSave(`${parts[0]}.${parts[1]}.zzz`)).toBeNull();
    expect(decodeSave('garbage')).toBeNull();
  });
});
