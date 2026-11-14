import * as THREE from 'three';
import { ABILITIES, type AbilityContext } from './abilities';
import { ACHIEVEMENTS, type Achievement, type RunEnd } from './achievements';
import { Actor } from './actor';
import { Ally } from './allies';
import { track } from './analytics';
import type { Assets } from './assets';
import { CLASSES, classById, type HeroClass } from './classes';
import type { Daily } from './daily';
import {
  CALM, CARDS, ENDLESS_CARDS, ENEMIES, ENEMY_NOTES, INTEREST, KEYSTONES, META, RELICS, TOWERS, WARES, WEAPONS, WEAPON_PRICE, baseUpgrades, callBonus, enemyHp,
  interestCap, isBossWave, warePrice, waveComposition, waveOptions, xpForLevel,
  type Card, type EnemyKind, type RelicId, type Upgrades, type Ware, type WaveOption, type Weapon, type WeaponId,
} from './data';
import { Economy, type EconomySnapshot, type FeelEvent, type Pad } from './economy';
import { Fx } from './fx';
import { Hero, type Input } from './hero';
import { ELITES, Horde, besideWall, type Elite, type Enemy } from './horde';
import type { Choice, Hud } from './hud';
import { MAPS, type MapDef } from './maps';
import { Projectiles } from './projectiles';
import { draw, pick, rand, reseed, restoreRng, rngState } from './rng';
import { save } from './save';
import { keyLabel, settings } from './settings';
import type { Sfx } from './sfx';
import { Tutorial } from './tutorial';
import { Wilds, normalized, type Site } from './wilds';
import { CAMP, GATE_SIDES, buildLighting, buildWeather, buildWorld, insideCamp, type Obstacle, type WallFade } from './world';

export type { Input } from './hero';

const FIRST_WAVE_DELAY = 14;
const WAVE_REST = 15;
/** Kills without being hurt that double the gold foes drop. */
const STREAK_FULL = 50;
const MERCHANT_EVERY = 3;
const MERCHANT_STAY = 2;
const EMBER_GAP = 0.3;
const EMBER_RADIUS = 1.7;
const STORM_EVERY = 5;
const WARD_GAP = 6;
const WARD_RADIUS = 6;
const KEEP_HP = 20;
/** Each endless wave adds this much health, and this much horde, to every foe and wave. */
const ENDLESS_HP = 0.14;
const ENDLESS_HORDE = 0.06;
const ENDLESS_PAY = 25;
const WAVE_CLEAR_HEAL = 0.3;
const HURT_GAP = 0.3;
const BOSS_DEATH_SLOWMO = 0.55;
const SLOWMO_RATE = 0.2;
const LOW_HP = 0.3;
const WOOD = 0x9a6233;
const DUST = 0xb9a584;
const GOLD = 0xffd24a;
const ELITE_WAVE = 4;
const ELITE_CHANCE = 0.08;
const KEYSTONE_LEVEL = 5;
const KEYSTONE_CHANCE = 0.18;
const WHIRL_TICK = 0.25;
const WHIRL_REACH = 4.5;
const SNAPSHOT_VERSION = 1;

interface Merchant { root: THREE.Object3D; actor: Actor; offers: Pad[]; leaveAt: number }

/** A run saved between waves, enough to rebuild it from the menu. */
export interface RunSnapshot {
  v: number; map: string; cls: string; daily: string | null; dailySeed: number; wave: number; endless: boolean;
  hp: number; xp: number; level: number; kills: number; elapsed: number; taken: string[]; relics: string[]; weapon: string;
  rng: [number, number]; economy: EconomySnapshot; ranger: number; streak: number; gatesLost: number; phoenixUsed: boolean;
  runStats: Game['runStats']; seen: string[];
}

/** Whether something read from the save is a run this build can resume. */
export function isSnapshot(x: unknown): x is RunSnapshot {
  const s = x as RunSnapshot | null;
  return !!s && typeof s === 'object' && s.v === SNAPSHOT_VERSION && MAPS.some((m) => m.id === s.map) && CLASSES.some((c) => c.id === s.cls)
    && typeof s.wave === 'number' && !!s.economy && Array.isArray(s.taken);
}

const ALL_CARDS: Card[] = [...CARDS, ...KEYSTONES, ...ENDLESS_CARDS];

/** Rounds a fractional amount up or down at random, keeping its average. */
const roll = (x: number) => Math.max(1, Math.floor(x) + (rand() < x % 1 ? 1 : 0));

/** Plural names for the first sighting banner. */
const PLURAL: Partial<Record<EnemyKind, string>> = { Hexer: 'Hexers', Shieldbearer: 'Shieldbearers', Archer: 'Skeleton archers', Sapper: 'Sappers' };

/** One run on one map: the hero, the horde, the economy and the waves that bind them. */
export class Game {
  readonly scene = new THREE.Scene();
  paused = false;
  private started = false;
  private over = false;
  private endless = false;
  private tutorial: Tutorial | null = null;
  private orbit = 0;
  private fx = new Fx(this.scene);
  private hero: Hero;
  private horde: Horde;
  private shots: Projectiles;
  private economy: Economy;
  private wilds: Wilds;
  private sun: THREE.DirectionalLight;
  private obstacles: Obstacle[];
  private walls: WallFade;
  private updateWeather: (dt: number, focus: THREE.Vector3) => void;
  private cls: HeroClass = CLASSES[0];
  private daily: Daily | null = null;
  private ranger: Ally | null = null;
  private rangerPad: Pad | null = null;
  private sellsword: Ally | null = null;
  private merchant: Merchant | null = null;
  private campQueue: Array<{ kind: EnemyKind; x: number; z: number }> = [];
  private hp = 100;
  private upgrades: Upgrades = baseUpgrades();
  private taken = new Map<string, number>();
  /** Every boon taken, in order, so a resumed run can replay them. */
  private takenOrder: string[] = [];
  private xp = 0;
  private level = 1;
  private pendingCards = 0;
  private offered: Choice[] | null = null;
  private pendingRelic = false;
  private relics = new Set<RelicId>();
  private kills = 0;
  private wave = 0;
  private toSpawn: EnemyKind[] = [];
  private spawnTimer = 0;
  private restTimer = FIRST_WAVE_DELAY;
  private options: [WaveOption, WaveOption] | null = null;
  private choice = 0;
  private current: WaveOption = { mod: CALM, horde: 1, gold: 0, boon: false };
  private cleared = true;
  private streak = 0;
  private fireTimer = 0;
  private shotsFired = 0;
  private emberTimer = 0;
  private wardReady = 0;
  private abilityCooldown = [0, 0];
  private hurtFlash = 0;
  private hurtTimer = 0;
  private hurtBank = 0;
  private slowmo = 0;
  private elapsed = 0;
  private frame = 0;
  private camFocus = new THREE.Vector3();
  private heroInside = true;
  /** Timed effects from abilities. */
  private boostMul = 1;
  private boostTime = 0;
  private invulnTime = 0;
  private stealthTime = 0;
  private empowerMul = 1;
  private empowerTime = 0;
  private whirlTime = 0;
  private whirlTick = 0;
  private phoenixUsed = false;
  private gatesLost = 0;
  private seen = new Set<EnemyKind>();
  /** Set while a saved run is being rebuilt, to keep the fanfare quiet. */
  private restoring = false;
  /** Counts for the run record and achievements. */
  private runStats = { bosses: 0, elites: 0, camps: 0, chests: 0, built: 0 };
  /** One line for the share button, set when a run ends. */
  shareText = '';

  constructor(private assets: Assets, private camera: THREE.PerspectiveCamera, private hud: Hud, readonly sfx: Sfx, readonly map: MapDef) {
    this.sun = buildLighting(this.scene, map.look);
    ({ obstacles: this.obstacles, walls: this.walls } = buildWorld(this.scene, assets, map));
    this.updateWeather = buildWeather(this.scene, map.look.weather);

    this.hero = new Hero(assets, this.scene);
    this.hero.setBody(this.cls.model, this.cls.accent, this.cls.crest);
    this.hero.equip(WEAPONS[this.cls.weapon]);

    this.economy = new Economy(this.scene, assets, this.obstacles, this.hero.root, {
      nearest: (from, range) => this.horde.nearest(from, range)?.actor.root.position ?? null,
      fire: (from, target, damage, count, chain) => {
        this.sfx.shoot(true);
        this.fx.burst(from.x, from.y, from.z, GOLD, 2, 4, 0.12);
        this.shots.fire(from, target, damage, count, 0, chain);
      },
      lob: (from, target, radius, burn) => this.shots.lob(from, target, radius, burn, Math.round((TOWERS.catapult.damage + this.upgrades.towerDamage) * this.upgrades.towerDamageMul)),
      aura: (x, z, radius, damage, slow, freeze) => { this.horde.aura(x, z, radius, damage, slow, freeze); },
      trap: (x, z, radius) => this.horde.trapPulse(x, z, radius),
      upgraded: (text, x, z) => {
        if (this.restoring) return;
        this.sfx.build();
        this.sfx.levelUp();
        this.fx.ring(x, z, GOLD, 6);
        this.fx.burst(x, 2, z, GOLD, 24, 9, 0.2);
        this.fx.shake(0.25);
        this.hud.banner(text);
      },
      keepRaised: (tier, x, z) => {
        this.upgrades.maxHp += KEEP_HP;
        this.hp = Math.min(this.upgrades.maxHp, this.hp + KEEP_HP);
        this.refreshHud();
        if (this.restoring) return;
        this.sfx.levelUp();
        this.fx.ring(x, z, GOLD, 9);
        this.fx.burst(x, 4, z, GOLD, 40, 12, 0.26);
        this.fx.shake(0.4);
        this.hud.banner(tier === 2 ? 'Keep II: beacons, cottages, a ranger' : 'Keep III: the mine and tier III towers');
      },
      onResources: () => this.refreshHud(),
      feel: (event, x, z, progress) => this.feel(event, x, z, progress ?? 0),
    }, this.upgrades, map);

    this.horde = new Horde(this.scene, assets, this.fx, this.sfx, map, this.obstacles, this.economy, {
      hero: () => this.hero.position,
      heroInside: () => this.heroInside,
      heroHidden: () => this.stealthTime > 0,
      speedMul: () => (this.current.mod.speed ?? 1) * (this.daily?.mod.speed ?? 1),
      hpFor: (kind) => Math.max(1, Math.round(enemyHp(kind, Math.max(1, this.wave), this.map) * (1 + this.past * ENDLESS_HP) * (this.daily?.mod.hp ?? 1))),
      castOrb: (from, damage, spread, arrows) => this.shots.castOrb(from, damage, spread, arrows),
      killed: (e) => this.killed(e),
      bossSpawned: () => this.hud.boss(this.map.boss.name),
      bossHealth: (fraction) => this.hud.bossHealth(fraction),
      bossFell: () => { this.hud.boss(null); this.slowmo = BOSS_DEATH_SLOWMO; this.runStats.bosses++; },
      bossEnraged: () => this.hud.banner(this.map.boss.enrage),
      heroStruck: (damage) => this.strike(damage),
      ignite: (x, z, radius, seconds) => this.shots.ignite(x, z, radius, seconds),
      radialOrbs: (from, count, damage) => this.shots.radialOrbs(from, count, damage),
      bossPower: () => 1 + this.wave * 0.04 + this.past * 0.1,
    });
    this.shots = new Projectiles(this.scene, assets, this.fx, this.sfx, {
      pool: () => this.horde.pool,
      damage: (e, amount, dir, quiet, source) => this.horde.damage(e, amount, dir, quiet, source),
      blast: (x, z, radius, amount, push, quiet) => this.horde.blast(x, z, radius, amount, push, quiet),
      slow: (e, factor, seconds) => this.horde.slow(e, factor, seconds),
      hero: () => this.hero.position,
      heroHit: (damage) => this.strike(damage),
      shake: (amount) => this.fx.shake(amount),
    });
    this.wilds = new Wilds(this.scene, assets, this.obstacles, map.openSides, {
      guards: (site) => this.wakeGuards(site),
      opened: (site) => this.siteOpened(site),
      announce: (text) => this.hud.banner(text),
      padClearance: (x, z) => this.economy.padClearance(x, z),
    });
    this.reset();
  }

  get weaponId(): WeaponId { return this.hero.weapon.id; }
  get running(): boolean { return this.started && !this.over; }
  get heroClass(): HeroClass { return this.cls; }
  /** What the music should play to. */
  get mood(): 'rest' | 'fight' | 'boss' {
    if (!this.running) return 'rest';
    if (this.horde.boss) return 'boss';
    return this.toSpawn.length > 0 || this.horde.waveAlive ? 'fight' : 'rest';
  }
  /** Waves past the map's last, in endless. */
  private get past(): number { return Math.max(0, this.wave - this.map.waves); }
  private get streakMul(): number { return 1 + Math.min(1, this.streak / STREAK_FULL); }
  private get resting(): boolean {
    return this.running && this.cleared && this.toSpawn.length === 0 && !(this.tutorial?.holdWaves ?? false);
  }

  /** A number key or face button: picks a card if one is offered, else a wave option. */
  pick(index: number): void {
    if (this.offered) this.chooseCard(index); else this.chooseOption(index);
  }

  setShake(on: boolean): void { this.fx.setShake(on); }
  setShadows(on: boolean): void { this.sun.castShadow = on; }

  /** Begins a run on this map with a class; a daily seeds everything, a snapshot resumes a saved run. */
  start(cls: HeroClass = this.cls, daily: Daily | null = null, snapshot: RunSnapshot | null = null): void {
    this.cls = cls;
    this.daily = daily;
    reseed(daily ? daily.seed : (Math.random() * 0xffffffff) >>> 0);
    this.reset();
    this.started = true;
    if (snapshot) { this.resume(snapshot); return; }
    track('run_start', { map: this.map.id, cls: cls.id, daily: !!daily });
    if (daily) this.hud.banner(`Daily: ${daily.mod.title}`);
    if (!save.data.tutorialDone && this.map.id === 'greenhollow' && !daily) this.tutorial = new Tutorial(this.scene);
  }

  /** Stops play and lets the map idle behind the menu. */
  toMenu(): void {
    this.reset();
    this.started = false;
  }

  /** Frees GPU resources; models shared through Assets are left alone. */
  dispose(): void {
    this.tutorial?.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.InstancedMesh & THREE.SkinnedMesh;
      if (mesh.isInstancedMesh) mesh.dispose();
      if (mesh.isSkinnedMesh) mesh.skeleton.dispose();
      const map = (mesh.material as THREE.MeshBasicMaterial | undefined)?.map;
      if (map instanceof THREE.CanvasTexture) map.dispose();
    });
  }

  /** A weapon the hero doesn't carry, for chests and the merchant. */
  private otherWeapon(): Weapon {
    return draw.pick(Object.values(WEAPONS).filter((w) => w.id !== this.hero.weapon.id));
  }

  /** Names the ability buttons after the class and the keys bound to them. */
  refreshAbilityLabels(): void {
    const keys = settings.data.keys;
    this.hud.abilityLabels(this.cls.abilities.map((id, i) => ({
      title: ABILITIES[id].title, key: keyLabel((i === 0 ? keys.ability1 : keys.ability2)[0] ?? ''),
    })));
  }

  reset(): void {
    const u = this.upgrades;
    Object.assign(u, baseUpgrades());
    for (const item of META) item.apply(u, save.level(item.id));
    this.cls.apply(u);
    const mod = this.daily?.mod;
    if (mod?.heroSpeed) u.speed *= mod.heroSpeed;
    if (mod?.heroHp) u.maxHp = Math.round(u.maxHp * mod.heroHp);
    u.towerRange = mod?.towerRange ?? 1;
    this.tutorial?.dispose();
    this.tutorial = null;
    this.paused = false;
    this.taken.clear();
    this.takenOrder = [];
    this.hp = u.maxHp;
    this.xp = 0;
    this.level = 1;
    this.pendingCards = 0;
    this.offered = null;
    this.hud.reset();
    this.elapsed = 0;
    this.kills = 0;
    this.wave = 0;
    this.toSpawn = [];
    this.restTimer = FIRST_WAVE_DELAY;
    this.fireTimer = 0;
    this.over = false;
    this.fx.clear();
    this.hurtFlash = this.hurtTimer = this.hurtBank = this.slowmo = 0;
    this.horde.reset();
    this.shots.clear();
    this.abilityCooldown = [0, 0];
    this.boostMul = this.empowerMul = 1;
    this.boostTime = this.invulnTime = this.stealthTime = this.empowerTime = this.whirlTime = this.whirlTick = 0;
    this.phoenixUsed = false;
    this.gatesLost = 0;
    this.seen.clear();
    this.hero.setBody(this.cls.model, this.cls.accent, this.cls.crest);
    this.hero.reset();
    this.hero.equip(WEAPONS[this.cls.weapon]);
    this.refreshAbilityLabels();
    this.camFocus.copy(this.hero.position);
    this.heroInside = true;
    this.runStats = { bosses: 0, elites: 0, camps: 0, chests: 0, built: 0 };
    this.endless = false;
    this.options = null;
    this.choice = 0;
    this.current = { mod: CALM, horde: 1, gold: 0, boon: false };
    this.cleared = true;
    this.streak = 0;
    this.relics.clear();
    this.pendingRelic = false;
    this.campQueue = [];
    this.shotsFired = 0;
    this.emberTimer = 0;
    this.wardReady = 0;
    this.shareText = '';
    this.ranger?.dispose();
    this.ranger = null;
    this.sellsword?.dispose();
    this.sellsword = null;
    if (this.merchant) { this.scene.remove(this.merchant.root); this.merchant = null; }
    this.economy.reset();
    this.economy.grant(u.startWood + (mod?.startWood ?? 0), u.startGold + (mod?.startGold ?? 0));
    this.rangerPad = this.offerRanger();
    this.wilds.reset();
    this.refreshHud();
  }

  private refreshHud(): void {
    this.hud.refresh({
      hp: this.hp, maxHp: this.upgrades.maxHp, xp: this.xp, xpNext: xpForLevel(this.level), level: this.level,
      wave: this.wave, waves: this.map.waves, endless: this.endless, streakMul: this.streakMul, kills: this.kills,
      wood: this.economy.wood, gold: this.economy.gold,
    });
  }

  private feel(event: FeelEvent, x: number, z: number, progress: number): void {
    if (event === 'build') this.runStats.built++;
    if (event === 'gateBreak') this.gatesLost++;
    if (this.restoring) return;
    switch (event) {
      case 'chop':
        this.sfx.chop();
        this.fx.burst(x, 1.8, z, WOOD, 5, 6, 0.18);
        this.hud.bump('wood');
        break;
      case 'fell':
        this.sfx.fell();
        this.fx.burst(x, 2, z, 0x5f8a3a, 14, 8, 0.24);
        this.fx.shake(0.15);
        break;
      case 'coin':
        this.sfx.coin();
        this.fx.burst(x, 1, z, GOLD, 3, 4, 0.12);
        this.hud.bump('gold');
        break;
      case 'pay':
        this.sfx.pay(progress);
        break;
      case 'build':
        this.sfx.build();
        this.fx.burst(x, 0.6, z, DUST, 26, 9, 0.3);
        this.fx.ring(x, z, 0xffe9b0, 6);
        this.fx.shake(0.35);
        break;
      case 'gateHit':
        this.sfx.gateHit();
        this.fx.burst(x, 2, z, WOOD, 3, 5, 0.16);
        break;
      case 'workerChop':
        this.fx.burst(x, 1.8, z, WOOD, 3, 5, 0.15);
        break;
      case 'deliver':
        this.fx.number(x, 2.6, z, `+${progress} wood`, '#e0b67a', 0.9);
        this.hud.bump('wood');
        break;
      case 'mined':
        this.sfx.coin();
        this.fx.number(x, 4, z, `+${progress} gold`, '#ffd24a', 0.9);
        this.fx.burst(x, 2, z, GOLD, 5, 4, 0.14);
        this.hud.bump('gold');
        break;
      case 'bought':
        this.sfx.levelUp();
        this.fx.ring(x, z, GOLD, 3);
        this.fx.burst(x, 1.5, z, GOLD, 16, 7, 0.18);
        break;
      case 'ruin':
        this.sfx.gateBreak();
        this.fx.burst(x, 2, z, WOOD, 40, 12, 0.32);
        this.fx.shake(0.45);
        this.hud.banner(insideCamp({ x, z }) ? 'A cottage was razed' : 'The mine was overrun');
        break;
      case 'gateBreak':
        this.sfx.gateBreak();
        this.fx.burst(x, 2, z, WOOD, 40, 12, 0.32);
        this.fx.shake(0.55);
        this.hud.banner('The barricade fell');
        break;
    }
  }

  // ---- Saving and resuming between waves ----

  private snapshot(): RunSnapshot {
    return {
      v: SNAPSHOT_VERSION, map: this.map.id, cls: this.cls.id, daily: this.daily?.key ?? null, dailySeed: this.daily?.seed ?? 0, wave: this.wave, endless: this.endless,
      hp: Math.round(this.hp), xp: this.xp, level: this.level, kills: this.kills, elapsed: this.elapsed, taken: [...this.takenOrder],
      relics: [...this.relics], weapon: this.hero.weapon.id, rng: rngState(), economy: this.economy.snapshot(), ranger: this.ranger?.level ?? 0,
      streak: this.streak, gatesLost: this.gatesLost, phoenixUsed: this.phoenixUsed, runStats: { ...this.runStats }, seen: [...this.seen],
    };
  }

  /** Rebuilds a saved run on a freshly reset game, resting before the next wave. */
  private resume(s: RunSnapshot): void {
    this.restoring = true;
    for (const id of s.taken) {
      const card = ALL_CARDS.find((c) => c.id === id);
      if (!card) continue;
      card.apply(this.upgrades);
      this.taken.set(id, (this.taken.get(id) ?? 0) + 1);
      this.takenOrder.push(id);
    }
    for (const id of s.relics) {
      const relic = RELICS.find((r) => r.id === id);
      if (!relic) continue;
      this.relics.add(relic.id);
      relic.apply?.(this.upgrades);
    }
    this.economy.restore(s.economy);
    for (let i = 0; i < s.ranger && this.rangerPad; i++) this.economy.forceComplete(this.rangerPad);
    this.restoring = false;
    const weapon = WEAPONS[s.weapon as WeaponId];
    if (weapon) this.hero.equip(weapon);
    this.wave = s.wave;
    this.endless = s.endless;
    this.xp = s.xp;
    this.level = s.level;
    this.kills = s.kills;
    this.elapsed = s.elapsed;
    this.streak = s.streak;
    this.gatesLost = s.gatesLost;
    this.phoenixUsed = s.phoenixUsed;
    this.runStats = { ...this.runStats, ...s.runStats };
    for (const k of s.seen) this.seen.add(k as EnemyKind);
    this.hp = Math.min(this.upgrades.maxHp, Math.max(1, s.hp));
    this.restTimer = WAVE_REST + this.upgrades.restBonus;
    restoreRng(s.rng);
    this.hud.banner(`Resumed before wave ${this.wave + 1}`);
    track('run_resume', { map: this.map.id, wave: this.wave });
    this.refreshHud();
  }

  // ---- Waves ----

  private startWave(): void {
    const option = this.options?.[this.choice] ?? this.current;
    this.wave++;
    this.current = option;
    this.options = null;
    this.cleared = false;
    this.restTimer = WAVE_REST + this.upgrades.restBonus;
    this.hud.showNext(false);
    this.upgrades.towerRange = (option.mod.towerRange ?? 1) * (this.daily?.mod.towerRange ?? 1);
    this.toSpawn = waveComposition(this.wave, this.map, option.mod, option.horde * (1 + this.past * ENDLESS_HORDE) * (this.daily?.mod.horde ?? 1));
    // Every standing camp sends its own band from the woods.
    for (const camp of this.wilds.camps) {
      const kinds: EnemyKind[] = Array<EnemyKind>(1 + Math.floor(this.wave * 0.3)).fill('Minion');
      if (this.wave >= 6) kinds.push('Warrior');
      for (const kind of kinds) this.campQueue.push({ kind, x: camp.x + (rand() - 0.5) * 4, z: camp.z + (rand() - 0.5) * 4 });
    }
    this.spawnTimer = 0;
    const boss = isBossWave(this.wave, this.map);
    const twist = option.mod === CALM ? '' : `: ${option.mod.title}`;
    this.hud.banner(boss ? `The ${this.map.boss.name} comes${twist}` : `Wave ${this.wave}${twist}`);
    this.sfx.horn(boss);
    if (boss) this.fx.shake(0.6);
    if (this.merchant && this.wave >= this.merchant.leaveAt) this.merchantLeaves();
    this.refreshHud();
  }

  /** Rewards and repairs once every foe of a wave is down; ends the run after the last wave. */
  private waveCleared(): void {
    this.cleared = true;
    this.upgrades.towerRange = this.daily?.mod.towerRange ?? 1;
    const heal = Math.round(this.upgrades.maxHp * WAVE_CLEAR_HEAL);
    this.hp = Math.min(this.upgrades.maxHp, this.hp + heal);
    const rent = this.economy.waveCleared();
    const interest = this.daily?.mod.noInterest ? 0 : Math.min(interestCap(this.wave), Math.floor(this.economy.gold * INTEREST));
    const reward = this.current.gold;
    this.economy.grant(0, interest + reward);
    if (this.current.boon) this.pendingCards++;
    const p = this.hero.position;
    this.sfx.cleared();
    this.hud.banner(this.current.boon ? 'Wave cleared: a boon earned' : 'Wave cleared');
    this.fx.number(p.x, 3.2, p.z, `+${heal}`, '#8fe86a', 1.3);
    const gold = rent + interest + reward;
    if (gold > 0) this.fx.number(p.x, 4.4, p.z, `+${gold} gold`, '#ffd24a', 1.2);
    this.fx.ring(p.x, p.z, 0x8fe86a, 5);
    if (this.sellsword && --this.sellsword.wavesLeft <= 0) { this.sellsword.dispose(); this.sellsword = null; }
    if (isBossWave(this.wave, this.map)) this.pendingRelic = this.openRelics().length > 0;
    this.wilds.waveCleared(this.wave);
    this.refreshHud();
    if (this.wave >= this.map.waves && !this.endless) { this.endRun(true); return; }
    if (!this.merchant && this.wave % MERCHANT_EVERY === 0) this.merchantArrives();
    if (!this.tutorial) save.setRun(this.snapshot());
  }

  /** Lays out the two ways the next wave can go. */
  private prepareOptions(): void {
    this.options = waveOptions(this.wave + 1);
    this.choice = 0;
    this.hud.options(this.wave > 0 ? this.options : [], this.choice, (i) => this.chooseOption(i));
    this.hud.showNext(true);
  }

  chooseOption(index: number): void {
    if (!this.options || this.wave === 0 || index > 1) return;
    this.choice = index;
    this.sfx.pick();
    this.hud.markChoice(index);
  }

  private earlyBonus(seconds: number, wave: number): number {
    return Math.round(callBonus(seconds, wave) * (this.relics.has('hourglass') ? 1.5 : 1));
  }

  /** Starts the next wave now, paying gold for the time skipped. */
  callWave(): void {
    if (!this.resting || this.paused || this.offered || !this.options) return;
    const bonus = this.earlyBonus(this.restTimer, this.wave + 1);
    if (bonus > 0) {
      this.economy.grant(0, bonus);
      const p = this.hero.position;
      this.fx.number(p.x, 3.6, p.z, `+${bonus} gold`, '#ffd24a', 1.2);
      this.hud.bump('gold');
    }
    this.startWave();
  }

  private updateNextPanel(): void {
    const seconds = Math.ceil(this.restTimer);
    const next = this.wave + 1;
    const boss = isBossWave(next, this.map);
    this.hud.countdown(seconds, `${boss ? `Wave ${next}: the ${this.map.boss.name}` : `Wave ${next}`} in ${seconds}s`, `Call now  +${this.earlyBonus(this.restTimer, next)} gold`);
  }

  private spawnOne(): boolean {
    const kind = this.toSpawn[this.toSpawn.length - 1];
    const side = pick(this.map.openSides);
    const [nx, nz] = GATE_SIDES[side];
    const river = this.map.river?.side === side ? this.map.river : null;
    // Across a river, foes gather on the far bank and must take the bridge.
    const dist = river ? river.distance + river.width / 2 + 3 + rand() * 5 : CAMP + 6 + rand() * 6;
    const lateral = (rand() - 0.5) * (river ? 4 : 6);
    const e = this.horde.spawn(kind, nx * dist + nz * lateral, nz * dist + nx * lateral, side, false);
    if (!e) return false;
    this.toSpawn.pop();
    const eliteMul = (this.current.mod.elites ?? 1) * (this.daily?.mod.elites ?? 1);
    if (kind !== 'Boss' && kind !== 'Hexer' && this.wave >= (eliteMul > 1 ? 2 : ELITE_WAVE) && rand() < ELITE_CHANCE * eliteMul) {
      this.horde.makeElite(e, pick(Object.keys(ELITES) as Elite[]));
    }
    const plural = PLURAL[kind];
    if (plural && !this.seen.has(kind) && kind !== 'Boss') this.hud.banner(`${plural}: ${ENEMY_NOTES[kind as Exclude<EnemyKind, 'Boss'>].toLowerCase()}`);
    this.seen.add(kind);
    return true;
  }

  private updateWaves(dt: number): void {
    if (this.tutorial) {
      if (this.tutorial.holdWaves) return;
      if (this.wave === 0) this.restTimer = Math.min(this.restTimer, 3);
    }
    if (this.toSpawn.length > 0 || this.campQueue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer > 0) return;
      let spawned = this.toSpawn.length > 0 && this.spawnOne();
      const band = this.campQueue[this.campQueue.length - 1];
      if (band) {
        const e = this.horde.spawn(band.kind, band.x, band.z, this.horde.nearestOpenSide(band), false);
        if (e) { this.campQueue.pop(); spawned = true; }
      }
      if (spawned) this.spawnTimer = Math.max(0.12, 0.55 - this.wave * 0.03);
      return;
    }
    if (this.horde.waveAlive) return;
    if (!this.cleared) { this.waveCleared(); if (this.over) return; }
    if (!this.options) this.prepareOptions();
    this.restTimer -= dt;
    this.updateNextPanel();
    if (this.restTimer <= 0) this.startWave();
  }

  /** After the last wave is won, carries on with ever harder waves. */
  pressOn(): void {
    if (!this.over || this.endless || this.hp <= 0) return;
    this.endless = true;
    this.over = false;
    this.hud.hideOver();
    this.hero.actor.play('Idle_A');
    this.restTimer = WAVE_REST + this.upgrades.restBonus;
    if (!this.merchant) this.merchantArrives();
    save.setRun(this.snapshot());
    this.refreshHud();
  }

  /** Grants every achievement the run just earned and returns them. */
  private checkAchievements(won: boolean): Achievement[] {
    const end: RunEnd = {
      map: this.map.id, cls: this.cls.id, won: won || this.endless, wave: this.wave, endlessHeld: this.endless ? Math.max(0, this.wave - 1 - this.map.waves) : 0,
      gatesLost: this.gatesLost, tier: this.economy.tier, towers: this.economy.stats.towers, seconds: this.elapsed, daily: this.daily?.key ?? null,
    };
    const earned = ACHIEVEMENTS.filter((a) => !save.has(a.id) && a.check(save.data, end));
    for (const a of earned) save.grant(a.id);
    return earned;
  }

  private endRun(won: boolean): void {
    this.over = true;
    track('run_end', { map: this.map.id, cls: this.cls.id, won, wave: this.wave, kills: this.kills, level: this.level, endless: this.endless, daily: !!this.daily });
    this.hud.showNext(false);
    if (won) this.sfx.win(); else this.sfx.lose();
    if (!won) this.fx.shake(0.8);
    this.pendingCards = 0;
    this.hideCards();
    this.hud.boss(null);
    this.hero.actor.play(won ? 'Idle_A' : 'Death_A', !won, 0.08);
    this.tutorial?.finish();
    this.tutorial = null;
    const minutes = Math.floor(this.elapsed / 60);
    const seconds = String(Math.floor(this.elapsed % 60)).padStart(2, '0');
    const as = `as the ${this.cls.title}`;
    const daily = this.daily ? ` on the ${this.daily.key} daily (${this.daily.mod.title})` : '';
    if (this.endless) {
      const held = Math.max(0, this.wave - 1 - this.map.waves);
      const banked = save.recordEndless(this.map, this.wave - 1, held * ENDLESS_PAY);
      const notes = this.checkAchievements(true).map((a) => `New: ${a.title}${a.reward ? `, unlocks ${a.reward}` : ''}`);
      this.shareText = `I held ${held} endless waves on ${this.map.name} ${as} in Palisade${daily}, slaying ${this.kills} skeletons.`;
      this.hud.over('The last stand ends', `You held ${held} endless ${held === 1 ? 'wave' : 'waves'}, to wave ${this.wave}, and slew ${this.kills} foes. ${banked} gold added to the treasury.`, false, notes);
      return;
    }
    const banked = save.recordRun({
      map: this.map, cls: this.cls.id, won, wave: this.wave, gold: this.economy.gold, kills: this.kills, level: this.level, seconds: this.elapsed,
      ...this.runStats, daily: this.daily?.key ?? null,
    });
    const notes = this.checkAchievements(won).map((a) => `New: ${a.title}${a.reward ? `, unlocks ${a.reward}` : ''}`);
    let score = won
      ? `All ${this.map.waves} waves repelled. ${this.kills} foes slain in ${minutes}:${seconds}, at level ${this.level}.`
      : `You held until wave ${this.wave} and slew ${this.kills} foes, at level ${this.level}.`;
    score += ` ${banked} gold added to the treasury.`;
    if (won) score += ' Press on for endless waves?';
    this.shareText = won
      ? `I held ${this.map.name} through all ${this.map.waves} waves ${as} in Palisade${daily}, in ${minutes}:${seconds}.`
      : `I held ${this.map.name} to wave ${this.wave} ${as} in Palisade${daily}, slaying ${this.kills} skeletons.`;
    this.hud.over(won ? 'The hamlet stands' : 'The hamlet has fallen', score, won, notes);
  }

  // ---- Merchant, allies and the wilds ----

  private merchantArrives(): void {
    const spot = this.economy.spotNear(0, 0, [6, 8, 10]);
    const root = new THREE.Group();
    root.position.set(spot.x, 0, spot.z);
    const cart = normalized(this.assets, 'wheelbarrow', 2.6);
    const sack = normalized(this.assets, 'sack', 1.1);
    sack.position.set(0.3, 0.9, 0);
    const actor = new Actor(this.assets, 'Rogue', 1);
    actor.root.position.set(0, 0, 1.6);
    actor.play('Idle_A');
    root.add(cart, sack, actor.root);
    root.rotation.y = Math.atan2(-spot.x, -spot.z);
    this.scene.add(root);
    this.fx.burst(spot.x, 1, spot.z, DUST, 20, 7, 0.24);

    const weapon = this.otherWeapon();
    const pool = draw.shuffle(WARES.filter((w) => (w.id !== 'mason' || this.economy.canFreeUpgrade) && (w.id !== 'sellsword' || !this.sellsword)));
    const wares: Ware[] = [{ id: 'weapon', title: weapon.title, text: weapon.text, gold: WEAPON_PRICE }, ...pool.slice(0, 2)];
    const offers: Pad[] = [];
    for (const ware of wares) {
      const at = this.economy.spotNear(spot.x, spot.z, [3.6, 4.8]);
      offers.push(this.economy.offer({
        x: at.x, z: at.z, title: ware.title, blurb: ware.text, wood: 0, gold: warePrice(ware.gold, this.wave), radius: 1.8,
        buy: () => { this.applyWare(ware, weapon); return null; },
      }));
    }
    this.merchant = { root, actor, offers, leaveAt: this.wave + MERCHANT_STAY };
    this.hud.banner('A merchant has come to town');
  }

  private merchantLeaves(): void {
    if (!this.merchant) return;
    for (const pad of this.merchant.offers) this.economy.withdraw(pad);
    const p = this.merchant.root.position;
    this.fx.burst(p.x, 1, p.z, DUST, 16, 6, 0.22);
    this.scene.remove(this.merchant.root);
    this.merchant = null;
  }

  private applyWare(ware: Ware, weapon: Weapon): void {
    const p = this.hero.position;
    switch (ware.id) {
      case 'weapon':
        this.hero.equip(weapon);
        this.hud.banner(`${weapon.title}: ${weapon.text.toLowerCase()}`);
        break;
      case 'draught':
        this.fx.number(p.x, 3.2, p.z, `+${Math.round(this.upgrades.maxHp - this.hp)}`, '#8fe86a', 1.3);
        this.hp = this.upgrades.maxHp;
        break;
      case 'lumber':
        this.economy.grant(30, 0);
        this.fx.number(p.x, 3.2, p.z, '+30 wood', '#e0b67a', 1.2);
        break;
      case 'mason':
        if (!this.economy.freeUpgrade()) this.economy.grant(0, warePrice(ware.gold, this.wave));
        break;
      case 'charm':
        this.pendingCards++;
        break;
      case 'sellsword':
        this.sellsword?.dispose();
        this.sellsword = new Ally(this.scene, this.assets, 'Barbarian', 'crossbow_2handed', 1, this.obstacles, 2);
        this.sellsword.place(p.x + 2, p.z + 2);
        this.hud.banner('A sellsword joins you for 2 waves');
        break;
    }
    this.refreshHud();
  }

  /** The ring beside the Keep that hires the ranger, then trains them. */
  private offerRanger(): Pad {
    const k = this.economy.keepSpot;
    const at = this.economy.spotNear(k.x, k.z, [4.4, 5.6]);
    return this.economy.offer({
      x: at.x, z: at.z, title: 'Hire a Ranger', blurb: 'An archer who follows you', wood: 10, gold: 30, minTier: 2,
      buy: () => {
        if (!this.ranger) {
          this.ranger = new Ally(this.scene, this.assets, 'Ranger', 'bow_withString', 0, this.obstacles);
          this.ranger.place(at.x, at.z);
          if (!this.restoring) this.hud.banner('A ranger joins you');
          return { title: 'Ranger II', blurb: 'Shoots 40% faster', wood: 0, gold: 35, minTier: 2 };
        }
        this.ranger.level++;
        if (!this.restoring) this.hud.banner(`Ranger ${this.ranger.level === 2 ? 'II' : 'III'}`);
        return this.ranger.level === 2 ? { title: 'Ranger III', blurb: 'Twin arrows, +1 damage', wood: 0, gold: 55, minTier: 3 } : null;
      },
    });
  }

  private updateAllies(dt: number): void {
    const ctx = {
      hero: this.hero.position,
      rate: this.upgrades.allyRate,
      nearest: (from: THREE.Vector3, range: number) => this.horde.nearest(from, range)?.actor.root.position ?? null,
      shoot: (from: THREE.Vector3, target: THREE.Vector3, damage: number, count: number) => {
        this.sfx.shoot(true);
        this.shots.fire(from, target, damage, count, 0);
      },
    };
    this.ranger?.update(dt, ctx);
    this.sellsword?.update(dt, ctx);
    if (this.merchant) this.merchant.actor.update(dt);
  }

  private wakeGuards(site: Site): void {
    const w = Math.max(1, this.wave);
    const kinds: EnemyKind[] = site.kind === 'chest'
      ? ['Minion', 'Minion', ...(w >= 4 ? ['Runner' as const] : [])]
      : ['Minion', 'Minion', 'Minion', 'Warrior', ...(w >= 6 ? ['Shieldbearer' as const] : []), ...(w >= 8 ? ['Hexer' as const] : [])];
    kinds.forEach((kind, i) => {
      const a = (i / kinds.length) * Math.PI * 2;
      const e = this.horde.spawn(kind, site.x + Math.cos(a) * 4, site.z + Math.sin(a) * 4, this.horde.nearestOpenSide(site), false);
      if (e) e.wild = true;
    });
  }

  private siteOpened(site: Site): void {
    const w = Math.max(1, this.wave);
    this.sfx.levelUp();
    this.fx.burst(site.x, 1.5, site.z, site.kind === 'camp' ? 0xd070ff : GOLD, 34, 11, 0.26);
    this.fx.ring(site.x, site.z, site.kind === 'camp' ? 0xff5a4a : GOLD, 5);
    if (site.kind === 'camp') {
      this.runStats.camps++;
      this.economy.grant(12, 20 + w * 4);
      this.fx.shake(0.4);
      this.hud.banner(`Camp razed: +${20 + w * 4} gold, +12 wood`);
      return;
    }
    this.runStats.chests++;
    const r = draw.next();
    if (r < 0.15) {
      const weapon = this.otherWeapon();
      this.hero.equip(weapon);
      this.hud.banner(`Found a ${weapon.title}: ${weapon.text.toLowerCase()}`);
    } else if (r < 0.35) {
      this.pendingCards++;
      this.hud.banner('Found a boon');
    } else if (r < 0.65) {
      this.economy.grant(14 + w * 2, 0);
      this.hud.banner(`Found ${14 + w * 2} wood`);
    } else {
      this.economy.grant(0, 12 + w * 3);
      this.hud.banner(`Found ${12 + w * 3} gold`);
    }
  }

  // ---- The hero ----

  /** A single hit on the hero from an orb, arrow or boss attack. */
  private strike(damage: number): void {
    if (this.over) return;
    this.hurtHero(damage);
    this.showHurt();
    this.refreshHud();
    if (this.hp <= 0) this.endRun(false);
  }

  /** Takes damage on the hero, softened by armour; ends the kill streak. A phoenix feather saves one killing blow. */
  private hurtHero(amount: number): void {
    if (this.invulnTime > 0) return;
    const dealt = amount * this.upgrades.armor;
    this.hp -= dealt;
    this.hurtBank += dealt;
    if (this.streak > 0) { this.streak = 0; this.refreshHud(); }
    if (this.hp <= 0 && this.relics.has('phoenix') && !this.phoenixUsed) {
      this.phoenixUsed = true;
      this.hp = this.upgrades.maxHp * 0.5;
      this.invulnTime = 1.5;
      const p = this.hero.position;
      this.fx.burst(p.x, 1.5, p.z, 0xff8a30, 50, 12, 0.3);
      this.fx.ring(p.x, p.z, 0xffb060, 8);
      this.horde.blast(p.x, p.z, 7, 6, 6);
      this.hud.banner('The phoenix feather burns: you rise again');
    }
    if (this.relics.has('ward') && this.elapsed >= this.wardReady) {
      this.wardReady = this.elapsed + WARD_GAP;
      const p = this.hero.position;
      this.horde.aura(p.x, p.z, WARD_RADIUS, 1, 0.4, true);
    }
  }

  /** Damage arrives every frame, so it is shown in small bundles. */
  private showHurt(): void {
    this.hurtTimer = HURT_GAP;
    if (this.hurtBank <= 0) return;
    const p = this.hero.position;
    this.hero.actor.flash();
    this.sfx.hurt();
    if (settings.data.vibrate) navigator.vibrate?.(40);
    this.fx.shake(0.22);
    this.fx.number(p.x, 3.2, p.z, `-${Math.ceil(this.hurtBank)}`, '#ff6a50', 1.2);
    this.hurtBank = 0;
    this.hurtFlash = 1;
  }

  private updateHurtOverlay(dt: number): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3.5);
    const low = !this.over && this.hp / this.upgrades.maxHp < LOW_HP ? 0.3 + Math.sin(this.elapsed * 7) * 0.12 : 0;
    this.hud.hurt(Math.max(this.hurtFlash * 0.75, low));
  }

  /** Rewards for a kill: gold, the streak, a relic's heal and experience. */
  private killed(e: Enemy): void {
    this.kills++;
    if (e.elite) this.runStats.elites++;
    const p = e.actor.root.position;
    const reward = (e.elite ? 3 : 1) * this.streakMul * this.upgrades.goldMul * (this.current.mod.gold ?? 1) * (this.daily?.mod.gold ?? 1);
    this.economy.dropGold(p.x, p.z, roll(ENEMIES[e.kind].gold * reward));
    this.streak++;
    if (this.relics.has('vampire') && this.hp < this.upgrades.maxHp) this.hp = Math.min(this.upgrades.maxHp, this.hp + 1);
    this.gainXp(ENEMIES[e.kind].xp * (e.elite ? 2 : 1));
  }

  private gainXp(amount: number): void {
    this.xp += amount;
    while (this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      this.pendingCards++;
      const p = this.hero.position;
      this.sfx.levelUp();
      this.fx.ring(p.x, p.z, 0x9fd8ff, 8);
      this.fx.burst(p.x, 1.2, p.z, 0x9fd8ff, 22, 9, 0.2);
    }
    this.refreshHud();
  }

  /** One hit of the current weapon, with every multiplier, times `mul`. */
  private boltDamage(mul = 1): number {
    const u = this.upgrades;
    return roll(u.damage * this.hero.weapon.damage * u.damageMul * (this.empowerTime > 0 ? this.empowerMul : 1) * mul);
  }

  private updateHero(dt: number, input: Input): void {
    const p = this.hero.position;
    const chopping = this.economy.update(dt, p);
    if (this.upgrades.regen > 0 && this.hp < this.upgrades.maxHp) {
      this.hp = Math.min(this.upgrades.maxHp, this.hp + this.upgrades.regen * dt);
      this.refreshHud();
    }
    this.boostTime = Math.max(0, this.boostTime - dt);
    this.invulnTime = Math.max(0, this.invulnTime - dt);
    this.stealthTime = Math.max(0, this.stealthTime - dt);
    this.empowerTime = Math.max(0, this.empowerTime - dt);
    const speed = this.upgrades.speed * (this.boostTime > 0 ? this.boostMul : 1);
    const moving = this.hero.move(dt, input, speed, this.obstacles);
    if (moving && this.relics.has('embers')) {
      this.emberTimer -= dt;
      if (this.emberTimer <= 0) { this.emberTimer = EMBER_GAP; this.shots.ignite(p.x, p.z, EMBER_RADIUS, 1.6); }
    }
    if (this.whirlTime > 0) {
      this.whirlTime -= dt;
      this.whirlTick -= dt;
      this.hero.root.rotation.y += dt * 18;
      if (this.whirlTick <= 0) {
        this.whirlTick = WHIRL_TICK;
        this.horde.cleave(p, WHIRL_REACH, this.boltDamage(0.8), 3);
        this.fx.ring(p.x, p.z, 0xffe0b0, WHIRL_REACH);
        this.sfx.chop();
      }
      this.hero.animate(dt, moving, false, this.elapsed);
      return;
    }

    const w = this.hero.weapon;
    const reach = w.reach ? w.reach + (this.upgrades.arrows - 1) * 0.6 : 0;
    const target = this.horde.nearest(p, reach || this.upgrades.range + w.range);
    let face: number | null = moving ? Math.atan2(input.x, input.z) : null;
    this.fireTimer -= dt;
    if (target) {
      const tp = target.actor.root.position;
      face = Math.atan2(tp.x - p.x, tp.z - p.z);
      if (this.fireTimer <= 0) {
        this.fireTimer = this.upgrades.fireInterval * w.interval;
        if (reach) {
          this.cleave(p, reach, this.boltDamage() + this.upgrades.pierce * 0.6);
        } else {
          this.sfx.shoot();
          const chain = this.relics.has('storm') && ++this.shotsFired % STORM_EVERY === 0;
          const u = this.upgrades;
          this.shots.fire(p.clone().setY(1.7), tp, this.boltDamage(), u.arrows, u.pierce + w.pierce, chain, undefined,
            { explode: u.explode + (w.blast ?? 0), frost: u.frost, bounce: u.bounce });
        }
      }
    }
    if (face !== null) this.hero.face(face, dt);
    this.hero.animate(dt, moving, chopping, this.elapsed);
  }

  /** A melee sweep at every foe within reach. */
  private cleave(p: THREE.Vector3, reach: number, damage: number): void {
    this.horde.cleave(p, reach, roll(damage));
    this.sfx.boulder();
    this.fx.ring(p.x, p.z, 0xffe0b0, reach);
    this.fx.burst(p.x, 1, p.z, 0xffe0b0, 10, 8, 0.16);
  }

  /** Uses the class's first or second ability. */
  useAbility(index: number): void {
    if (!this.running || this.paused || this.offered || this.abilityCooldown[index] > 0) return;
    const ability = ABILITIES[this.cls.abilities[index]];
    this.abilityCooldown[index] = ability.cooldown;
    const ctx: AbilityContext = {
      hero: this.hero.position, facing: this.hero.root.rotation.y, upgrades: this.upgrades, horde: this.horde, shots: this.shots, fx: this.fx, sfx: this.sfx,
      boltDamage: (mul = 1) => this.boltDamage(mul),
      boost: (mul, seconds) => { this.boostMul = mul; this.boostTime = seconds; },
      invulnerable: (seconds) => { this.invulnTime = Math.max(this.invulnTime, seconds); },
      stealth: (seconds) => { this.stealthTime = seconds; },
      empower: (mul, seconds) => { this.empowerMul = mul; this.empowerTime = seconds; },
      whirl: (seconds) => { this.whirlTime = seconds; this.whirlTick = 0; },
      banner: (text) => this.hud.banner(text),
    };
    ability.use(ctx);
    track('ability', { id: ability.id });
  }

  private updateAbilities(dt: number): void {
    for (let i = 0; i < 2; i++) {
      this.abilityCooldown[i] = Math.max(0, this.abilityCooldown[i] - dt / this.upgrades.cooldown);
      this.hud.abilityCooldown(i, this.abilityCooldown[i] / ABILITIES[this.cls.abilities[i]].cooldown);
    }
  }

  private updateEnemies(dt: number): void {
    this.heroInside = besideWall(this.hero.position, this.heroInside);
    const touching = this.horde.update(dt);
    if (touching > 0 && this.stealthTime <= 0) {
      this.hurtHero(touching * dt);
      this.hurtTimer -= dt;
      if (this.hurtTimer <= 0) this.showHurt();
      this.refreshHud();
      if (this.hp <= 0) this.endRun(false);
    } else if (this.hurtTimer > 0) {
      this.hurtTimer -= dt;
    }
  }

  // ---- Boons and relics ----

  /** Relics not yet held whose unlock, if any, has been earned. */
  private openRelics() {
    return RELICS.filter((r) => !this.relics.has(r.id) && (!r.unlock || save.has(r.unlock)));
  }

  /** Offers three relics not yet held, after a boss falls. */
  private showRelics(): void {
    this.pendingRelic = false;
    const open = draw.shuffle(this.openRelics()).slice(0, 3);
    if (open.length === 0) return;
    this.present(`The ${this.map.boss.name} has fallen: claim a relic`, open.map((r) => ({
      title: r.title, text: r.text,
      pick: () => { this.relics.add(r.id); r.apply?.(this.upgrades); this.hud.banner(r.title); },
    })));
  }

  /** Three boons: ordinary ones while any remain, a rare keystone after level five, endless ones once all are maxed. */
  private showCards(): void {
    const open = CARDS.filter((c) => (this.taken.get(c.id) ?? 0) < c.max);
    let picked = draw.shuffle([...open]).slice(0, 3);
    const keystoneTaken = KEYSTONES.some((k) => this.taken.has(k.id));
    if (!keystoneTaken && this.level >= KEYSTONE_LEVEL && draw.next() < KEYSTONE_CHANCE) {
      picked = [draw.pick(KEYSTONES), ...picked.slice(0, 2)];
    }
    if (picked.length < 3) picked.push(...draw.shuffle([...ENDLESS_CARDS]).slice(0, 3 - picked.length));
    this.present('Choose a boon', picked.map((card) => ({
      title: card.title, text: card.text,
      pick: () => {
        this.pendingCards--;
        const before = this.upgrades.maxHp;
        card.apply(this.upgrades);
        this.taken.set(card.id, (this.taken.get(card.id) ?? 0) + 1);
        this.takenOrder.push(card.id);
        if (card.id === 'vitality') this.hp += 25;
        if (card.id === 'secondwind') this.hp += this.upgrades.maxHp / 2;
        if (this.upgrades.maxHp > before && card.id !== 'vitality') this.hp += this.upgrades.maxHp - before;
        this.hp = Math.min(this.hp, this.upgrades.maxHp);
        track('boon', { id: card.id });
      },
    })));
  }

  /** Pauses play to offer a choice of three. */
  private present(heading: string, choices: Choice[]): void {
    this.offered = choices;
    this.hud.present(heading, choices, (i) => this.chooseCard(i));
  }

  private hideCards(): void {
    this.offered = null;
    this.hud.hideCards();
  }

  chooseCard(index: number): void {
    const choice = this.offered?.[index];
    if (!choice) return;
    this.sfx.pick();
    this.hideCards();
    choice.pick();
    this.refreshHud();
  }

  // ---- Camera and the frame ----

  private updateMenuCamera(dt: number): void {
    this.orbit += dt * 0.09;
    const distance = this.camera.aspect < 1 ? 92 : 72;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = distance + 16;
    fog.far = distance + 70;
    this.camera.position.set(Math.sin(this.orbit) * distance * 0.74, distance * 0.62, Math.cos(this.orbit) * distance * 0.74);
    this.camera.lookAt(0, 1, 0);
    this.sun.position.set(-34, 44, 20);
    this.sun.target.position.set(0, 0, 0);
  }

  private updateCamera(dt: number): void {
    const aspect = this.camera.aspect;
    const dist = aspect < 1 ? 64 : 52;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = dist + 16;
    fog.far = dist + 70;
    this.camFocus.lerp(this.hero.position, Math.min(1, dt * 6));
    this.camera.position.set(this.camFocus.x, dist * 0.68, this.camFocus.z + dist * 0.74);
    this.camera.lookAt(this.camFocus.x, 0.8, this.camFocus.z - 0.5);
    this.fx.applyShake(this.camera);
    this.walls.update(this.camFocus, dt);
    this.sun.position.set(this.camFocus.x - 34, 44, this.camFocus.z + 20);
    this.sun.target.position.copy(this.camFocus);
  }

  update(dt: number, input: Input): void {
    this.hud.update(dt);
    this.updateWeather(dt, this.camFocus);
    if (!this.started) {
      this.updateMenuCamera(dt);
      return;
    }
    if (this.paused) return;
    this.frame++;
    this.fx.update(dt);
    if (this.frame % 2 === 0) this.hud.edges(this.camera, this.horde.pool, this.wilds.all, this.running);
    this.updateHurtOverlay(dt);
    if (!this.over && !this.offered) {
      if (this.pendingRelic) this.showRelics();
      else if (this.pendingCards > 0) this.showCards();
    }
    if (this.offered) {
      this.updateCamera(dt);
      return;
    }
    if (this.tutorial) {
      this.tutorial.update(dt, this.hero.position, this.economy, this.kills);
      if (this.tutorial.done) this.tutorial = null;
    }
    const simDt = this.slowmo > 0 ? dt * SLOWMO_RATE : dt;
    this.slowmo = Math.max(0, this.slowmo - dt);
    if (!this.over) this.elapsed += simDt;
    if (this.over) {
      this.hero.actor.update(dt);
      for (const e of this.horde.pool) if (e.active) e.actor.update(dt);
    } else {
      this.updateHero(simDt, input);
      this.updateAllies(simDt);
      this.wilds.update(simDt, this.hero.position, this.elapsed, this.wave);
      this.updateAbilities(simDt);
      this.shots.update(simDt);
      if (this.over) return;
      this.updateEnemies(simDt);
      this.updateWaves(simDt);
    }
    this.updateCamera(dt);
  }

  get debug() {
    return {
      cls: this.cls.id, daily: this.daily?.key ?? null, weapon: this.hero.weapon.id, relics: [...this.relics].join(), ranger: this.ranger?.level ?? 0,
      sellsword: !!this.sellsword, merchant: !!this.merchant, camps: this.wilds.camps.length, sites: this.wilds.all.length, streak: this.streak,
      endless: this.endless, mod: this.current.mod.id, phase: this.horde.phase, boss: !!this.horde.boss, hp: Math.round(this.hp), maxHp: this.upgrades.maxHp,
      wave: this.wave, kills: this.kills, active: this.horde.activeCount, over: this.over, level: this.level, cards: this.offered?.length ?? 0,
      taken: this.takenOrder.join(), ...this.economy.stats,
    };
  }

  /** Dev helpers for testing late-game states quickly. */
  get cheat() {
    return {
      wave: (n: number) => { this.wave = n - 1; this.restTimer = 0.5; },
      gold: (n: number) => this.economy.grant(n, n),
      card: (id: string) => { const c = ALL_CARDS.find((x) => x.id === id); if (c) { c.apply(this.upgrades); this.takenOrder.push(id); } },
      relic: (id: RelicId) => { const r = RELICS.find((x) => x.id === id); if (r) { this.relics.add(id); r.apply?.(this.upgrades); } },
      boss: () => { const [nx, nz] = GATE_SIDES[this.map.openSides[0]]; this.horde.spawn('Boss', nx * (CAMP + 6), nz * (CAMP + 6), this.map.openSides[0], false); },
      hurtBoss: (fraction: number) => { const b = this.horde.boss; if (b) this.horde.damage(b, Math.ceil(b.maxHp * fraction), new THREE.Vector3()); },
      spawn: (kind: EnemyKind) => { const [nx, nz] = GATE_SIDES[this.map.openSides[0]]; this.horde.spawn(kind, nx * (CAMP + 6), nz * (CAMP + 6), this.map.openSides[0], false); },
      save: () => save.setRun(this.snapshot()),
    };
  }
}
