import type { MapDef } from './maps';

const KEY = 'palisade.save';
const VERSION = 1;
/** Share of unspent gold kept after a defeat. */
const LOSS_KEEP = 0.5;

export interface MapRecord { wave: number; won: boolean; endless?: number }

export interface SaveData {
  version: number;
  treasury: number;
  meta: Record<string, number>;
  best: Record<string, MapRecord>;
  lastMap: string;
  tutorialDone: boolean;
}

const fresh = (): SaveData => ({ version: VERSION, treasury: 0, meta: {}, best: {}, lastMap: '', tutorialDone: false });

function read(): SaveData {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<SaveData> | null;
    if (!parsed || parsed.version !== VERSION) return fresh();
    return { ...fresh(), ...parsed, treasury: Math.max(0, Math.floor(Number(parsed.treasury) || 0)) };
  } catch {
    return fresh(); // Storage blocked or corrupt: play on without saved progress.
  }
}

class Save {
  data = read();

  persist(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* progress lasts this session only */ }
  }

  level(id: string): number { return this.data.meta[id] ?? 0; }

  /** Spends from the treasury; returns false if there isn't enough. */
  buy(id: string, cost: number): boolean {
    if (this.data.treasury < cost) return false;
    this.data.treasury -= cost;
    this.data.meta[id] = this.level(id) + 1;
    this.persist();
    return true;
  }

  /** Banks a finished run and returns the gold added. */
  recordRun(map: MapDef, won: boolean, wave: number, gold: number): number {
    const banked = won ? gold + map.winBonus : Math.floor(gold * LOSS_KEEP);
    this.data.treasury += banked;
    const best = this.data.best[map.id];
    if (!best || won || (!best.won && wave > best.wave)) this.data.best[map.id] = { wave, won: won || !!best?.won };
    this.persist();
    return banked;
  }

  /** Banks an endless run's pay and keeps the furthest wave reached; returns the gold added. */
  recordEndless(map: MapDef, wave: number, pay: number): number {
    this.data.treasury += pay;
    const best = this.data.best[map.id] ?? { wave: map.waves, won: true };
    best.won = true;
    if (wave > map.waves) best.endless = Math.max(best.endless ?? 0, wave);
    this.data.best[map.id] = best;
    this.persist();
    return pay;
  }

  setLastMap(id: string): void { this.data.lastMap = id; this.persist(); }
  finishTutorial(): void { this.data.tutorialDone = true; this.persist(); }
}

export const save = new Save();
