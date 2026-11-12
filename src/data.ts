import { pick, rand, shuffle } from './rng';
export type EnemyKind = 'Minion' | 'Runner' | 'Warrior' | 'Hexer' | 'Boss';

export interface RangedAttack { range: number; interval: number; damage: number }

export interface EnemyStats {
  model: string; walk: string; scale: number; hp: number; speed: number; dps: number;
  hitRadius: number; xp: number; gold: number; cap: number; ranged?: RangedAttack;
}

export const ENEMIES: Record<EnemyKind, EnemyStats> = {
  Minion: { model: 'Skeleton_Minion', walk: 'Walking_A', scale: 1.1, hp: 4, speed: 4.4, dps: 7, hitRadius: 1.1, xp: 1, gold: 1, cap: 90 },
  Runner: { model: 'Skeleton_Rogue', walk: 'Running_A', scale: 1.05, hp: 3, speed: 7.2, dps: 6, hitRadius: 1, xp: 1, gold: 1, cap: 30 },
  Warrior: { model: 'Skeleton_Warrior', walk: 'Walking_A', scale: 1.3, hp: 12, speed: 3.2, dps: 16, hitRadius: 1.3, xp: 3, gold: 3, cap: 30 },
  Hexer: {
    model: 'Skeleton_Mage', walk: 'Walking_A', scale: 1.2, hp: 9, speed: 3.2, dps: 5, hitRadius: 1.2, xp: 4, gold: 4, cap: 14,
    ranged: { range: 12, interval: 2.6, damage: 9 },
  },
  Boss: { model: 'Skeleton_Warrior', walk: 'Walking_A', scale: 3, hp: 90, speed: 3.4, dps: 30, hitRadius: 2.4, xp: 15, gold: 15, cap: 1 },
};

export interface WaveRules { waves: number; hpScale: number; hordeScale: number; runnerRate: number; hexerRate: number }

/** A map's extra difficulty arrives gradually, so its opening waves stay fair. */
const ramp = (scale: number, wave: number): number => 1 + (scale - 1) * Math.min(1, wave / 8);

export const isBossWave = (wave: number, rules: WaveRules): boolean => wave % 5 === 0 || wave === rules.waves;

/** Spawn order for a wave; the last entry spawns first. */
export function waveComposition(wave: number, rules: WaveRules, mod: WaveMod = CALM, horde = 1): EnemyKind[] {
  const scale = ramp(rules.hordeScale, wave) * horde * (mod.horde ?? 1);
  let runners = wave >= 3 ? Math.floor(wave * 0.5 * rules.runnerRate) : 0;
  const hexers = (wave >= 6 ? Math.max(1, Math.floor((wave - 4) * 0.4 * rules.hexerRate)) : 0) + (wave >= 3 ? mod.hexers ?? 0 : 0);
  let minions = Math.max(0, Math.round((6 + wave * 3) * scale) - runners);
  const swarm = Math.round(minions * (mod.runners ?? 0));
  minions -= swarm;
  runners += swarm;
  const warriors = Math.round((Math.floor(wave / 2) + Math.max(0, wave - 7)) * scale * (mod.warriors ?? 1));
  const list: EnemyKind[] = [
    ...Array<EnemyKind>(minions).fill('Minion'), ...Array<EnemyKind>(runners).fill('Runner'),
    ...Array<EnemyKind>(warriors).fill('Warrior'), ...Array<EnemyKind>(hexers).fill('Hexer'),
  ];
  shuffle(list);
  if (isBossWave(wave, rules)) list.push('Boss');
  return list;
}

export function enemyHp(kind: EnemyKind, wave: number, rules: WaveRules): number {
  const base = kind === 'Boss' ? ENEMIES.Boss.hp * (Math.max(wave, 5) / 5) ** 1.35 : ENEMIES[kind].hp + Math.floor(wave / 3);
  return Math.round(base * ramp(rules.hpScale, wave));
}

export type TowerKind = 'ballista' | 'catapult' | 'beacon';

export interface TowerSpec { title: string; blurb: string; wood: number; gold: number; range: number; interval: number; damage: number }

export const TOWERS: Record<TowerKind, TowerSpec> = {
  ballista: { title: 'Ballista', blurb: 'Fast single bolts', wood: 12, gold: 5, range: 17, interval: 0.7, damage: 2 },
  catapult: { title: 'Catapult', blurb: 'Boulders hit an area', wood: 16, gold: 15, range: 24, interval: 2.4, damage: 6 },
  beacon: { title: 'Frost Beacon', blurb: 'Slows nearby foes', wood: 10, gold: 30, range: 9, interval: 0.8, damage: 1 },
};

export const BASE_TOWER_INTERVAL = 0.7;

export type UpgradeKey = TowerKind | 'barricade';
export interface UpgradeStep { wood: number; gold: number; title: string; text: string; short: string }

/** Costs and names for levels 2 and 3 of each structure. */
export const UPGRADES: Record<UpgradeKey, [UpgradeStep, UpgradeStep]> = {
  ballista: [
    { wood: 8, gold: 20, title: 'Ballista II', text: 'Ballista II: harder, faster bolts', short: '+1 damage, 20% faster' },
    { wood: 16, gold: 45, title: 'Ballista III', text: 'Ballista III: twin bolts, longer reach', short: 'Twin bolts, +5 range' },
  ],
  catapult: [
    { wood: 8, gold: 25, title: 'Catapult II', text: 'Catapult II: wider blasts', short: 'Bigger blasts' },
    { wood: 16, gold: 50, title: 'Catapult III', text: 'Catapult III: boulders leave fire', short: 'Leaves burning ground' },
  ],
  beacon: [
    { wood: 8, gold: 25, title: 'Beacon II', text: 'Frost Beacon II: wider and colder', short: 'Wider, stronger slow' },
    { wood: 16, gold: 50, title: 'Beacon III', text: 'Frost Beacon III: freezes foes solid', short: 'Freezes foes solid' },
  ],
  barricade: [
    { wood: 15, gold: 0, title: 'Stone Gate', text: 'Stone Gate: twice as sturdy', short: 'Double health' },
    { wood: 25, gold: 0, title: 'Spiked Gate', text: 'Spiked Gate: hurts attackers and mends itself', short: 'Spikes, self-repair' },
  ],
};

export const xpForLevel = (level: number): number => 5 + level * 4;

export interface Upgrades {
  damage: number; fireInterval: number; range: number; arrows: number; pierce: number;
  speed: number; chopInterval: number; magnet: number; towerInterval: number; maxHp: number; regen: number;
  startWood: number; startGold: number;
  /** Run-wide changes from relics and the current wave. */
  towerDamage: number; towerRange: number; armor: number; cooldown: number; thornWalls: number; goldMul: number;
}

export const baseUpgrades = (): Upgrades => ({
  damage: 2, fireInterval: 0.38, range: 17, arrows: 1, pierce: 0,
  speed: 11, chopInterval: 0.28, magnet: 6, towerInterval: 0.7, maxHp: 100, regen: 0, startWood: 0, startGold: 0,
  towerDamage: 0, towerRange: 1, armor: 1, cooldown: 1, thornWalls: 0, goldMul: 1,
});

export interface MetaUpgrade { id: string; title: string; text: string; max: number; baseCost: number; apply(u: Upgrades, level: number): void }

/** Permanent upgrades bought with banked gold between runs. */
export const META: MetaUpgrade[] = [
  { id: 'heart', title: 'Stout Heart', text: '+15 max health', max: 5, baseCost: 120, apply: (u, n) => { u.maxHp += 15 * n; } },
  { id: 'yard', title: 'Stocked Yard', text: 'Start each run with +6 wood', max: 4, baseCost: 100, apply: (u, n) => { u.startWood += 6 * n; } },
  { id: 'chest', title: 'War Chest', text: 'Start each run with +5 gold', max: 4, baseCost: 100, apply: (u, n) => { u.startGold += 5 * n; } },
  { id: 'greaves', title: 'Light Greaves', text: 'Move 5% faster', max: 3, baseCost: 150, apply: (u, n) => { u.speed *= 1 + 0.05 * n; } },
  { id: 'engineers', title: 'Master Engineers', text: 'Towers fire 8% faster', max: 3, baseCost: 250, apply: (u, n) => { u.towerInterval *= 0.92 ** n; } },
  { id: 'oath', title: "Fletcher's Oath", text: '+1 bolt damage', max: 2, baseCost: 500, apply: (u, n) => { u.damage += n; } },
];

export const metaCost = (item: MetaUpgrade, level: number): number => item.baseCost * (level + 1);

export interface Card { id: string; title: string; text: string; max: number; apply(u: Upgrades): void }

export const CARDS: Card[] = [
  { id: 'multishot', title: 'Split Bolts', text: 'Fire one extra bolt per shot', max: 3, apply: (u) => { u.arrows += 1; } },
  { id: 'rapid', title: 'Quick Hands', text: 'Shoot 18% faster', max: 5, apply: (u) => { u.fireInterval *= 0.82; } },
  { id: 'heavy', title: 'Heavy Bolts', text: '+1 bolt damage', max: 6, apply: (u) => { u.damage += 1; } },
  { id: 'pierce', title: 'Piercing Tips', text: 'Bolts pass through one more foe', max: 3, apply: (u) => { u.pierce += 1; } },
  { id: 'range', title: 'Keen Eye', text: '+3 shooting range', max: 3, apply: (u) => { u.range += 3; } },
  { id: 'boots', title: 'Swift Boots', text: 'Move 12% faster', max: 4, apply: (u) => { u.speed *= 1.12; } },
  { id: 'axe', title: 'Sharp Axe', text: 'Chop 25% faster', max: 3, apply: (u) => { u.chopInterval *= 0.75; } },
  { id: 'magnet', title: 'Coin Purse', text: 'Collect gold from farther away', max: 3, apply: (u) => { u.magnet += 3; } },
  { id: 'drill', title: 'Ballista Drills', text: 'Towers fire 20% faster', max: 4, apply: (u) => { u.towerInterval *= 0.8; } },
  { id: 'vitality', title: 'Vitality', text: '+25 max health and heal 25', max: 5, apply: (u) => { u.maxHp += 25; } },
  { id: 'medic', title: 'Field Medic', text: 'Recover 1.5 health per second', max: 4, apply: (u) => { u.regen += 1.5; } },
];

/** A twist on one wave, announced before it starts. Missing fields mean no change. */
export interface WaveMod {
  id: string; title: string; text: string;
  horde?: number; runners?: number; warriors?: number; hexers?: number;
  elites?: number; speed?: number; towerRange?: number; gold?: number;
}

export const CALM: WaveMod = { id: 'calm', title: 'Quiet March', text: 'An ordinary wave' };

export const MILD_MODS: WaveMod[] = [
  CALM,
  { id: 'gilded', title: 'Gilded Bones', text: 'Foes drop double gold', gold: 2, horde: 1.1 },
  { id: 'stragglers', title: 'Stragglers', text: 'Fewer, slower foes', horde: 0.8, speed: 0.85 },
  { id: 'swarm', title: 'Swarm', text: 'Lots of fast runners', runners: 0.45 },
];

export const HARD_MODS: WaveMod[] = [
  { id: 'armored', title: 'Armored', text: 'Three times the elites', elites: 3 },
  { id: 'fog', title: 'Fog', text: 'Towers see 30% less far', towerRange: 0.7 },
  { id: 'brutes', title: 'Brutes', text: 'Twice the warriors', warriors: 2 },
  { id: 'hexes', title: 'Hex Storm', text: 'Extra hexers', hexers: 3 },
  { id: 'haste', title: 'Haste', text: 'Foes move 20% faster', speed: 1.2 },
];

/** The harder choice also brings a bigger horde. */
export const STAKES_HORDE = 1.3;

/** One of the two ways the next wave can go, and what clearing it pays. */
export interface WaveOption { mod: WaveMod; horde: number; gold: number; boon: boolean }

export function waveOptions(wave: number): [WaveOption, WaveOption] {
  const steady: WaveOption = { mod: wave <= 1 ? CALM : pick(MILD_MODS), horde: 1, gold: 6 + wave * 2, boon: false };
  const boon = rand() < 0.5;
  const stakes: WaveOption = { mod: pick(HARD_MODS), horde: STAKES_HORDE, gold: boon ? 0 : 30 + wave * 6, boon };
  return [steady, stakes];
}

export type RelicId = 'storm' | 'embers' | 'vampire' | 'idol' | 'ward' | 'siege' | 'aegis' | 'thorns' | 'echo';

export interface Relic { id: RelicId; title: string; text: string; apply?(u: Upgrades): void }

/** Run-long powers; one is picked after each boss falls. */
export const RELICS: Relic[] = [
  { id: 'storm', title: 'Storm Bolts', text: 'Every fifth bolt arcs lightning to 3 more foes' },
  { id: 'embers', title: 'Ember Trail', text: 'You leave burning ground as you run' },
  { id: 'vampire', title: 'Bloodthirst', text: 'Heal 1 health for every kill' },
  { id: 'idol', title: 'Golden Idol', text: 'Foes drop 50% more gold', apply: (u) => { u.goldMul *= 1.5; } },
  { id: 'ward', title: 'Frost Ward', text: 'Getting hit freezes the foes around you' },
  { id: 'siege', title: 'Siege Masters', text: 'Towers hit harder and fire 15% faster', apply: (u) => { u.towerDamage += 1; u.towerInterval *= 0.85; } },
  { id: 'aegis', title: "Warden's Aegis", text: 'Take 25% less damage', apply: (u) => { u.armor *= 0.75; } },
  { id: 'thorns', title: 'Thorned Walls', text: 'Every barricade hurts its attackers', apply: (u) => { u.thornWalls = 1; } },
  { id: 'echo', title: 'Echoing Horn', text: 'Volley and Bash recharge twice as fast', apply: (u) => { u.cooldown *= 0.5; } },
];

export type WeaponId = 'crossbow' | 'longbow' | 'arbalest' | 'greataxe';

export interface Weapon {
  id: WeaponId; title: string; text: string; model: string;
  /** Multipliers on shot interval and damage, plus extra range and pierce. */
  interval: number; damage: number; range: number; pierce: number;
  /** Melee weapons hit every foe within `reach` instead of shooting. */
  reach?: number;
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  crossbow: { id: 'crossbow', title: 'Crossbow', text: 'A steady all-rounder', model: 'crossbow_1handed', interval: 1, damage: 1, range: 0, pierce: 0 },
  longbow: { id: 'longbow', title: 'Longbow', text: 'Fast, far-reaching, lighter shots', model: 'bow_withString', interval: 0.6, damage: 0.68, range: 6, pierce: 0 },
  arbalest: { id: 'arbalest', title: 'Arbalest', text: 'Slow, heavy bolts that pierce lines', model: 'crossbow_2handed', interval: 1.7, damage: 2.3, range: 2, pierce: 2 },
  greataxe: { id: 'greataxe', title: 'Greataxe', text: 'Cleaves every foe around you', model: 'axe_2handed', interval: 1.8, damage: 2.6, range: 0, pierce: 0, reach: 4.8 },
};

export type WareId = 'draught' | 'lumber' | 'mason' | 'charm' | 'sellsword' | 'weapon';

export interface Ware { id: WareId; title: string; text: string; gold: number }

/** What the travelling merchant may sell. Prices rise with the wave. */
export const WARES: Ware[] = [
  { id: 'draught', title: 'Healing Draught', text: 'Restore full health', gold: 14 },
  { id: 'lumber', title: 'Lumber Cart', text: '+30 wood', gold: 16 },
  { id: 'mason', title: 'Master Mason', text: 'A free upgrade', gold: 26 },
  { id: 'charm', title: 'Lucky Charm', text: 'Gain a boon', gold: 32 },
  { id: 'sellsword', title: 'Sellsword', text: 'Fights for you for 2 waves', gold: 28 },
];
export const WEAPON_PRICE = 24;
export const warePrice = (gold: number, wave: number): number => Math.round(gold * (1 + wave * 0.06));

/** Costs and unlocks for raising the Keep to tiers II and III. */
export const KEEP_TIERS: Array<{ wood: number; gold: number; title: string; text: string }> = [
  { wood: 25, gold: 25, title: 'Raise the Keep', text: 'Beacons, cottages, a ranger' },
  { wood: 45, gold: 60, title: 'Raise the Keep', text: 'Gold mine, tier III towers' },
];

/** Share of unspent gold paid as interest after a wave, up to a cap that grows with the wave. */
export const INTEREST = 0.1;
export const interestCap = (wave: number): number => 5 + wave * 2;
/** Gold per second skipped when calling a wave early. */
export const callBonus = (seconds: number, wave: number): number => Math.round(seconds * (0.8 + wave * 0.1));
