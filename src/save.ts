import type { MapDef } from './maps';
import { hashString } from './rng';

const KEY = 'palisade.save';
export const SAVE_VERSION = 2;
/** Share of unspent gold kept after a defeat. */
const LOSS_KEEP = 0.5;
const HISTORY_MAX = 30;
const DAILY_KEEP = 90;

export interface MapRecord { wave: number; won: boolean; endless?: number }

/** One finished run, newest first in `history`. */
export interface RunRecord {
  at: number; map: string; cls: string; won: boolean; wave: number; waves: number; kills: number; level: number;
  seconds: number; endless: number; daily: string | null; banked: number;
}

export interface Stats {
  runs: number; wins: number; kills: number; waves: number; bosses: number; elites: number; gold: number;
  seconds: number; camps: number; chests: number; built: number; endless: number;
}

export interface DailyRecord { wave: number; won: boolean; kills: number; score: number; cls: string }

export interface SaveData {
  version: number;
  treasury: number;
  meta: Record<string, number>;
  best: Record<string, MapRecord>;
  lastMap: string;
  tutorialDone: boolean;
  lastClass: string;
  stats: Stats;
  history: RunRecord[];
  achievements: string[];
  /** Daily results by date key (YYYY-MM-DD). */
  daily: Record<string, DailyRecord>;
  /** Consecutive days with a daily run played. */
  streak: { last: string; count: number };
  /** A run saved between waves, restored from the menu. Typed by snapshot.ts. */
  run: unknown | null;
}

/** What a finished run reports to the save. */
export interface RunSummary {
  map: MapDef; cls: string; won: boolean; wave: number; gold: number; kills: number; level: number; seconds: number;
  bosses: number; elites: number; camps: number; chests: number; built: number; daily: string | null;
}

export const freshStats = (): Stats => ({ runs: 0, wins: 0, kills: 0, waves: 0, bosses: 0, elites: 0, gold: 0, seconds: 0, camps: 0, chests: 0, built: 0, endless: 0 });

export const fresh = (): SaveData => ({
  version: SAVE_VERSION, treasury: 0, meta: {}, best: {}, lastMap: '', tutorialDone: false, lastClass: 'warden',
  stats: freshStats(), history: [], achievements: [], daily: {}, streak: { last: '', count: 0 }, run: null,
});

type Raw = Record<string, unknown>;

/** Each step upgrades a save from version n to n + 1, keeping everything the player earned. */
const MIGRATIONS: Record<number, (d: Raw) => Raw> = {
  // Maps already held keep their unlocks: the win achievements are granted from the old records.
  1: (d) => {
    const best = (typeof d.best === 'object' && d.best ? d.best : {}) as Record<string, MapRecord>;
    const achievements = Object.entries(best).filter(([, r]) => r?.won).map(([id]) => `win-${id}`);
    return { ...d, version: 2, lastClass: 'warden', stats: freshStats(), history: [], achievements, daily: {}, streak: { last: '', count: 0 }, run: null };
  },
};

const num = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Turns whatever was stored into a current save, upgrading old versions and tolerating junk. */
export function migrate(raw: unknown): SaveData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fresh();
  let d = raw as Raw;
  let version = Math.floor(num(d.version));
  if (version < 1) return fresh();
  while (version < SAVE_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return fresh();
    d = step(d);
    version = Math.floor(num(d.version));
  }
  // A save from a newer build keeps what this build understands.
  const base = fresh();
  const data: SaveData = { ...base, ...(d as Partial<SaveData>), version: SAVE_VERSION };
  data.treasury = Math.max(0, Math.floor(num(data.treasury)));
  data.meta = typeof data.meta === 'object' && data.meta ? data.meta : {};
  data.best = typeof data.best === 'object' && data.best ? data.best : {};
  data.history = Array.isArray(data.history) ? data.history.slice(0, HISTORY_MAX) : [];
  data.achievements = Array.isArray(data.achievements) ? data.achievements.filter((a) => typeof a === 'string') : [];
  data.stats = { ...freshStats(), ...(typeof data.stats === 'object' && data.stats ? data.stats : {}) };
  data.daily = typeof data.daily === 'object' && data.daily ? data.daily : {};
  data.streak = typeof data.streak === 'object' && data.streak ? { last: String(data.streak.last ?? ''), count: Math.max(0, Math.floor(num(data.streak.count))) } : base.streak;
  if (typeof data.lastClass !== 'string') data.lastClass = 'warden';
  return data;
}

const PREFIX = 'PALISADE1';

/** A save as a pasteable string with a checksum, so a typo is caught instead of imported. */
export function encodeSave(data: SaveData): string {
  const json = JSON.stringify({ ...data, run: null });
  const body = btoa(unescape(encodeURIComponent(json)));
  return `${PREFIX}.${body}.${hashString(json).toString(36)}`;
}

/** The save in an exported string, or null if it is damaged. */
export function decodeSave(text: string): SaveData | null {
  const parts = text.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    const json = decodeURIComponent(escape(atob(parts[1])));
    if (hashString(json).toString(36) !== parts[2]) return null;
    return migrate(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Today as a key, in UTC so everyone gets the same daily. */
export const dateKey = (date = new Date()): string => date.toISOString().slice(0, 10);

function read(): SaveData {
  try {
    return migrate(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
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

  /** Banks a finished run, records it, and returns the gold added. */
  recordRun(r: RunSummary): number {
    const banked = r.won ? r.gold + r.map.winBonus : Math.floor(r.gold * LOSS_KEEP);
    this.data.treasury += banked;
    const best = this.data.best[r.map.id];
    if (!best || r.won || (!best.won && r.wave > best.wave)) this.data.best[r.map.id] = { wave: r.wave, won: r.won || !!best?.won, endless: best?.endless };
    const s = this.data.stats;
    s.runs++;
    if (r.won) s.wins++;
    s.kills += r.kills;
    s.waves += Math.max(0, r.wave - (r.won ? 0 : 1));
    s.bosses += r.bosses;
    s.elites += r.elites;
    s.gold += banked;
    s.seconds += Math.round(r.seconds);
    s.camps += r.camps;
    s.chests += r.chests;
    s.built += r.built;
    this.data.history.unshift({
      at: Date.now(), map: r.map.id, cls: r.cls, won: r.won, wave: r.wave, waves: r.map.waves, kills: r.kills, level: r.level,
      seconds: Math.round(r.seconds), endless: 0, daily: r.daily, banked,
    });
    this.data.history.length = Math.min(this.data.history.length, HISTORY_MAX);
    if (r.daily && !this.data.daily[r.daily]) {
      this.data.daily[r.daily] = { wave: r.wave, won: r.won, kills: r.kills, score: r.wave * 1000 + r.kills, cls: r.cls };
      const keys = Object.keys(this.data.daily).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - DAILY_KEEP))) delete this.data.daily[k];
      this.bumpStreak(r.daily);
    }
    this.data.run = null;
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
    this.data.stats.gold += pay;
    this.data.stats.endless = Math.max(this.data.stats.endless, Math.max(0, wave - map.waves));
    const last = this.data.history[0];
    if (last && last.map === map.id) last.endless = Math.max(0, wave - map.waves);
    this.data.run = null;
    this.persist();
    return pay;
  }

  private bumpStreak(day: string): void {
    const previous = new Date(day);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const yesterday = dateKey(previous);
    const s = this.data.streak;
    s.count = s.last === yesterday ? s.count + 1 : s.last === day ? s.count : 1;
    s.last = day;
  }

  has(achievement: string): boolean { return this.data.achievements.includes(achievement); }

  /** Records an achievement; returns true the first time. */
  grant(achievement: string): boolean {
    if (this.has(achievement)) return false;
    this.data.achievements.push(achievement);
    this.persist();
    return true;
  }

  setRun(snapshot: unknown | null): void { this.data.run = snapshot; this.persist(); }
  setLastMap(id: string): void { this.data.lastMap = id; this.persist(); }
  setLastClass(id: string): void { this.data.lastClass = id; this.persist(); }
  finishTutorial(): void { this.data.tutorialDone = true; this.persist(); }

  export(): string { return encodeSave(this.data); }

  /** Replaces progress with an exported string; false if the string is not a valid save. */
  import(text: string): boolean {
    const data = decodeSave(text);
    if (!data) return false;
    this.data = data;
    this.persist();
    return true;
  }
}

export const save = new Save();
