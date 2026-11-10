import type { RangedAttack, TowerKind, WaveRules } from './data';

export interface BossDef {
  name: string;
  model: string;
  /** Emissive colour, or 0 for none. */
  glow: number;
  /** Casts a fan of `spread` orbs. */
  ranged?: RangedAttack & { spread: number };
  /** Raises minions around itself. */
  summon?: { interval: number; count: number };
}

export interface MapLook {
  ground: string;
  blotches: string[];
  road: string;
  specks: [string, string];
  sky: number;
  hemi: [number, number, number];
  sun: [number, number];
  stone: [number, number, number];
  foliage: [number, number, number] | null;
  weather: 'none' | 'snow' | 'embers';
  /** Colours of the preview swatch on the map button. */
  swatch: [string, string];
}

export interface MapDef extends WaveRules {
  id: string;
  name: string;
  blurb: string;
  difficulty: string;
  /** Extra gold banked for winning. */
  winBonus: number;
  buildingColor: 'blue' | 'yellow' | 'red';
  /** Gate sides that enemies can come through; indices into GATE_SIDES. */
  openSides: number[];
  buildings: Array<[kind: string, x: number, z: number, rot: number, scale: number]>;
  props: Array<[model: string, x: number, z: number, rot: number, scale: number, radius: number]>;
  trees: Array<[number, number]>;
  pads: Array<{ tower: TowerKind; x: number; z: number }>;
  forest: string[];
  boss: BossDef;
  look: MapLook;
}

export const MAPS: MapDef[] = [
  {
    id: 'greenhollow',
    name: 'Greenhollow',
    blurb: 'A quiet farming hamlet with a gate on every side.',
    difficulty: 'Gentle',
    winBonus: 100,
    waves: 12, hpScale: 1, hordeScale: 1, runnerRate: 0.7, hexerRate: 0.6,
    buildingColor: 'blue',
    openSides: [0, 1, 2, 3],
    buildings: [
      ['tavern', -10, -11, 0.4, 2.6], ['barracks', 11, -11, -0.4, 2.6], ['windmill', -12, 11, 2.4, 2.6],
      ['home_A', 11, 10, -2.3, 2.6], ['home_B', 15, 14, -2.7, 2.2], ['home_B', -15, -5, 1.2, 2.2],
      ['home_A', 15, -5, -1.2, 2.2], ['well', 5, 5, 0.3, 2],
    ],
    props: [
      ['tent', 7, -5, 0.8, 2.6, 2], ['resource_lumber', -6, 3, 1.1, 2.6, 1.3],
    ],
    trees: [[3.5, -13], [-15, 4], [-9, -1], [9, 1.5], [-3, -11], [-8.5, 6.5], [2.5, 10.5], [16, 7.5]],
    pads: [
      { tower: 'ballista', x: -5, z: -6 }, { tower: 'catapult', x: 3, z: -7 },
      { tower: 'ballista', x: -6.5, z: 14 }, { tower: 'beacon', x: 5.5, z: 15 },
    ],
    forest: ['trees_A_large', 'trees_B_large', 'tree_single_A', 'tree_single_B', 'rock_single_A', 'rock_single_C'],
    boss: { name: 'Bone Tyrant', model: 'Skeleton_Warrior', glow: 0 },
    look: {
      ground: '#5f8f3a',
      blotches: ['rgba(74,120,44,0.5)', 'rgba(120,160,62,0.4)', 'rgba(52,100,44,0.4)', 'rgba(146,168,74,0.28)'],
      road: 'rgba(166,128,80,0.55)',
      specks: ['rgba(30,60,20,0.16)', 'rgba(205,215,130,0.13)'],
      sky: 0xf0c79a, hemi: [0xdfe8ff, 0x70684a, 1.7], sun: [0xffe2bd, 2.7],
      stone: [0.72, 0.95, 1.35], foliage: null, weather: 'none',
      swatch: ['#79a845', '#f0c79a'],
    },
  },
  {
    id: 'frostmere',
    name: 'Frostmere',
    blurb: 'Two gates, walled flanks, and swift runners on the ice.',
    difficulty: 'Steady',
    winBonus: 250,
    waves: 15, hpScale: 1.6, hordeScale: 1.3, runnerRate: 1.6, hexerRate: 0.8,
    buildingColor: 'yellow',
    openSides: [0, 1],
    buildings: [
      ['church', 14, 0, -1.57, 2.6], ['tavern', -14, 0, 1.57, 2.6], ['home_A', -13, -12, 0.6, 2.4],
      ['home_B', 13, -12, -0.6, 2.2], ['market', -13, 11, 2.4, 2.4], ['blacksmith', 13, 11, -2.4, 2.4], ['well', -6, 0, 0.3, 2],
    ],
    props: [
      ['tent', -7, 16, 0.5, 2.6, 2], ['resource_lumber', 7, -16, 0.3, 2.6, 1.3],
    ],
    trees: [[5, -9], [-5, -9], [7, 8], [-7, 7], [10, -4], [10, 5], [-10, -5], [-10, 5]],
    pads: [
      { tower: 'ballista', x: -7, z: -14 }, { tower: 'catapult', x: 3.5, z: -5 }, { tower: 'beacon', x: 7, z: -14 },
      { tower: 'ballista', x: 7, z: 14 }, { tower: 'catapult', x: -3.5, z: 9 }, { tower: 'beacon', x: -7, z: 13 },
    ],
    boss: { name: 'Frost Lich', model: 'Skeleton_Mage', glow: 0x3a90ff, ranged: { range: 15, interval: 2.4, damage: 10, spread: 3 } },
    forest: ['trees_A_large', 'trees_B_large', 'trees_A_medium', 'rock_single_A', 'rock_single_C', 'rock_single_D'],
    look: {
      ground: '#d5e2ea',
      blotches: ['rgba(186,206,224,0.5)', 'rgba(244,249,252,0.55)', 'rgba(168,194,216,0.32)', 'rgba(228,236,244,0.4)'],
      road: 'rgba(132,146,162,0.42)',
      specks: ['rgba(120,146,174,0.14)', 'rgba(255,255,255,0.3)'],
      sky: 0xc2d5e8, hemi: [0xe8f2ff, 0x8898a8, 1.75], sun: [0xfff1df, 2.1],
      stone: [0.74, 1.02, 1.5], foliage: [1.15, 1.45, 1.75], weather: 'snow',
      swatch: ['#dce8f0', '#7fa3c4'],
    },
  },
  {
    id: 'ashfall',
    name: 'Ashfall',
    blurb: 'A burned town under siege by tougher foes and hexers.',
    difficulty: 'Hard',
    winBonus: 500,
    waves: 15, hpScale: 2, hordeScale: 1.45, runnerRate: 1, hexerRate: 2,
    buildingColor: 'red',
    openSides: [0, 1, 2, 3],
    buildings: [
      ['tavern', -11, -12, 0.5, 2.6], ['barracks', 12, -12, -0.5, 2.6], ['windmill', -12, 12, 2.2, 2.6],
      ['blacksmith', 12, 12, -2.2, 2.6], ['home_A', -16, -6, 1.2, 2.2], ['home_B', 16, 6, -1.4, 2.2], ['market', 7, -6, -0.8, 2.3], ['well', -5, 6, 0.3, 2],
    ],
    props: [
      ['resource_lumber', -8, -8, 0.8, 2.6, 1.3],
    ],
    trees: [[3, -13], [-14, 5], [-8, -2], [10, 1], [-3, -10], [-9, 8], [3, 12], [16, -1]],
    pads: [
      { tower: 'ballista', x: -5, z: -6 }, { tower: 'catapult', x: 13, z: -5.5 }, { tower: 'beacon', x: 0, z: 8 },
      { tower: 'ballista', x: -6.5, z: 15 }, { tower: 'catapult', x: 7, z: 15 }, { tower: 'beacon', x: -11, z: -5.5 },
    ],
    boss: { name: 'Ash Colossus', model: 'Skeleton_Warrior', glow: 0xff4a10, summon: { interval: 7, count: 3 } },
    forest: ['trees_A_cut', 'trees_B_cut', 'tree_single_A', 'tree_single_B', 'rock_single_A', 'rock_single_D', 'rock_single_C'],
    look: {
      ground: '#544640',
      blotches: ['rgba(38,30,28,0.5)', 'rgba(104,72,56,0.42)', 'rgba(70,58,54,0.5)', 'rgba(132,76,48,0.22)'],
      road: 'rgba(120,84,60,0.5)',
      specks: ['rgba(15,10,10,0.2)', 'rgba(240,130,60,0.09)'],
      sky: 0xcf7a50, hemi: [0xffd6b4, 0x4a3830, 1.9], sun: [0xffa56a, 3],
      stone: [0.62, 0.66, 0.82], foliage: [0.55, 0.42, 0.36], weather: 'embers',
      swatch: ['#54463f', '#e0693a'],
    },
  },
];

/** Building models a map needs beyond those always loaded. */
export function mapModels(map: MapDef): string[] {
  const extra = ['tower_base', 'tower_A', 'castle', 'mine', 'home_A'];
  return [...new Set([...map.buildings.map(([kind]) => kind), ...extra].map((kind) => buildingModel(map, kind)))];
}

/** How much farther apart everything inside the walls sits than in the layouts above. */
export const LAYOUT = 1.4;
for (const m of MAPS) {
  for (const b of m.buildings) { b[1] *= LAYOUT; b[2] *= LAYOUT; }
  for (const p of m.props) { p[1] *= LAYOUT; p[2] *= LAYOUT; }
  for (const t of m.trees) { t[0] *= LAYOUT; t[1] *= LAYOUT; }
  for (const p of m.pads) { p.x *= LAYOUT; p.z *= LAYOUT; }
}

export const buildingModel = (map: MapDef, kind: string): string => `building_${kind}_${map.buildingColor}`;
