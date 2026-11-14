import { CLASSES } from './classes';
import type { SaveData } from './save';

/** How a run ended, for checking achievements. */
export interface RunEnd {
  map: string; cls: string; won: boolean; wave: number; endlessHeld: number; gatesLost: number; tier: number; towers: number;
  seconds: number; daily: string | null;
}

export interface Achievement {
  id: string; title: string; text: string;
  /** What it unlocks, shown beside it. */
  reward?: string;
  check(save: SaveData, run: RunEnd): boolean;
}

const wonWith = (save: SaveData, cls: string) => save.history.some((r) => r.won && r.cls === cls);

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'win-greenhollow', title: 'Hamlet Held', text: 'Hold Greenhollow', reward: 'The Ranger and Thornford', check: (_, r) => r.won && r.map === 'greenhollow' },
  { id: 'win-thornford', title: 'Bridge Keeper', text: 'Hold Thornford', reward: 'Frostmere', check: (_, r) => r.won && r.map === 'thornford' },
  { id: 'win-frostmere', title: 'Winter Watch', text: 'Hold Frostmere', reward: 'The Mage and Ashfall', check: (_, r) => r.won && r.map === 'frostmere' },
  { id: 'win-ashfall', title: 'Through the Fire', text: 'Hold Ashfall', check: (_, r) => r.won && r.map === 'ashfall' },
  { id: 'unbroken', title: 'Unbroken', text: 'Hold any map without losing a barricade', check: (_, r) => r.won && r.gatesLost === 0 },
  { id: 'unbroken-frost', title: 'Ice Wall', text: 'Hold Frostmere without losing a barricade', check: (_, r) => r.won && r.map === 'frostmere' && r.gatesLost === 0 },
  { id: 'keep-iii', title: 'Castellan', text: 'Raise the Keep to tier III', check: (_, r) => r.tier >= 3 },
  { id: 'tower-town', title: 'Tower Town', text: 'Stand six towers at once', check: (_, r) => r.towers >= 6 },
  { id: 'swift-hold', title: 'Swift Hold', text: 'Hold Greenhollow in under 12 minutes', check: (_, r) => r.won && r.map === 'greenhollow' && r.seconds < 720 },
  { id: 'slay-500', title: 'Bone Breaker', text: 'Slay 500 foes in all', reward: 'The Barbarian', check: (s) => s.stats.kills >= 500 },
  { id: 'slay-5000', title: 'Ossuary', text: 'Slay 5,000 foes in all', check: (s) => s.stats.kills >= 5000 },
  { id: 'camps-10', title: 'Camp Burner', text: 'Raze 10 skeleton camps', reward: 'The Rogue', check: (s) => s.stats.camps >= 10 },
  { id: 'bosses-10', title: 'Giant Slayer', text: 'Fell 10 bosses', reward: 'Banner of Rally relic', check: (s) => s.stats.bosses >= 10 },
  { id: 'elites-100', title: 'Elite Hunter', text: 'Slay 100 elites', check: (s) => s.stats.elites >= 100 },
  { id: 'gold-2000', title: 'Treasurer', text: 'Bank 2,000 gold in all', reward: 'Lodestone relic', check: (s) => s.stats.gold >= 2000 },
  { id: 'endless-10', title: 'Last Stand', text: 'Hold 10 endless waves', reward: 'Phoenix Feather relic', check: (_, r) => r.endlessHeld >= 10 },
  { id: 'daily-1', title: 'Daily Bread', text: 'Finish a daily challenge', check: (_, r) => !!r.daily },
  { id: 'daily-3', title: 'Regular', text: 'Play the daily three days running', reward: 'Hourglass relic', check: (s) => s.streak.count >= 3 },
  { id: 'all-classes', title: 'Every Banner', text: 'Hold a map with every class', check: (s) => CLASSES.every((c) => wonWith(s, c.id)) },
];

export const achievementById = (id: string): Achievement | undefined => ACHIEVEMENTS.find((a) => a.id === id);
