import { MAPS, type MapDef } from './maps';
import { hashString } from './rng';
import { dateKey } from './save';

/** A rule that holds for a whole daily run. Missing fields mean no change. */
export interface DailyMod {
  id: string; title: string; text: string;
  /** Foe health, horde size and gold dropped, as multipliers. */
  hp?: number; horde?: number; gold?: number;
  /** Elite chance multiplier, foe speed, tower range. */
  elites?: number; speed?: number; towerRange?: number;
  /** The hero's speed and health, as multipliers. */
  heroSpeed?: number; heroHp?: number;
  startWood?: number; startGold?: number;
  noInterest?: boolean;
}

export const DAILY_MODS: DailyMod[] = [
  { id: 'bone-tide', title: 'Bone Tide', text: 'Hordes are 40% bigger, but every foe is 25% frailer', horde: 1.4, hp: 0.75 },
  { id: 'gold-rush', title: 'Gold Rush', text: 'Foes drop double gold, but the treasury pays no interest', gold: 2, noInterest: true },
  { id: 'iron-night', title: 'Iron Night', text: 'Elites are three times as common', elites: 3 },
  { id: 'long-fog', title: 'Long Fog', text: 'Towers see a quarter less far all run', towerRange: 0.75 },
  { id: 'frenzy', title: 'Frenzy', text: 'Foes move 15% faster; so do you, by 10%', speed: 1.15, heroSpeed: 1.1 },
  { id: 'royal-grant', title: 'Royal Grant', text: 'Start with 40 wood and 40 gold, but foes are 20% tougher', startWood: 40, startGold: 40, hp: 1.2 },
  { id: 'brittle', title: 'Brittle Bones', text: 'Foes have half their health; so do you', hp: 0.5, heroHp: 0.5 },
];

export interface Daily { key: string; seed: number; map: MapDef; mod: DailyMod }

/** Today's challenge: the same map, rule and seed for everyone, from the UTC date. */
export function dailyFor(date = new Date()): Daily {
  const key = dateKey(date);
  const seed = hashString(`palisade-daily-${key}`);
  return { key, seed, map: MAPS[seed % MAPS.length], mod: DAILY_MODS[Math.floor(seed / MAPS.length) % DAILY_MODS.length] };
}
