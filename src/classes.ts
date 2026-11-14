import type { AbilityId } from './abilities';
import type { Upgrades, WeaponId } from './data';
import { save } from './save';

export type ClassId = 'warden' | 'ranger' | 'barbarian' | 'mage' | 'rogue';

export interface HeroClass {
  id: ClassId;
  title: string;
  text: string;
  /** What the class is always good at. */
  passive: string;
  model: string;
  /** Cape colour. */
  accent: number;
  /** The Warden's helmet plume. */
  crest: boolean;
  weapon: WeaponId;
  abilities: [AbilityId, AbilityId];
  /** Achievement that unlocks the class, or null for the starting one. */
  unlock: string | null;
  unlockHint: string;
  apply(u: Upgrades): void;
}

export const CLASSES: HeroClass[] = [
  {
    id: 'warden', title: 'Warden', text: 'The hamlet\'s sworn defender', passive: 'Stout: +25 health and barricades hold 50% more',
    model: 'Knight', accent: 0xb3202c, crest: true, weapon: 'crossbow', abilities: ['volley', 'bash'], unlock: null, unlockHint: '',
    apply: (u) => { u.maxHp += 25; u.gateHp *= 1.5; },
  },
  {
    id: 'ranger', title: 'Ranger', text: 'A hunter from the deep woods', passive: 'Hawkeye: +4 range and bolts pierce one more foe',
    model: 'Ranger', accent: 0x3f7a3a, crest: false, weapon: 'longbow', abilities: ['rain', 'dash'], unlock: 'win-greenhollow', unlockHint: 'Hold Greenhollow',
    apply: (u) => { u.range += 4; u.pierce += 1; },
  },
  {
    id: 'barbarian', title: 'Barbarian', text: 'Happiest in the thick of it', passive: 'Thick skin: +40 health and take 15% less damage',
    model: 'Barbarian', accent: 0x8a4a1a, crest: false, weapon: 'greataxe', abilities: ['whirlwind', 'warcry'], unlock: 'slay-500', unlockHint: 'Slay 500 foes in all',
    apply: (u) => { u.maxHp += 40; u.armor *= 0.85; },
  },
  {
    id: 'mage', title: 'Mage', text: 'Keeps the horde at arm\'s length', passive: 'Attuned: abilities recharge 25% faster',
    model: 'Mage', accent: 0x3a5fb0, crest: false, weapon: 'staff', abilities: ['fireball', 'frostnova'], unlock: 'win-frostmere', unlockHint: 'Hold Frostmere',
    apply: (u) => { u.cooldown *= 0.75; },
  },
  {
    id: 'rogue', title: 'Rogue', text: 'Quick fingers, quicker feet', passive: 'Cutpurse: 30% more gold and move 10% faster',
    model: 'Rogue_Hooded', accent: 0x2a2a3a, crest: false, weapon: 'daggers', abilities: ['smoke', 'fan'], unlock: 'camps-10', unlockHint: 'Raze 10 skeleton camps',
    apply: (u) => { u.goldMul *= 1.3; u.speed *= 1.1; },
  },
];

export const classById = (id: string): HeroClass => CLASSES.find((c) => c.id === id) ?? CLASSES[0];

/** Locked classes can still be tried in a dev build. */
export const classUnlocked = (c: HeroClass): boolean => !c.unlock || save.has(c.unlock) || import.meta.env.DEV;
