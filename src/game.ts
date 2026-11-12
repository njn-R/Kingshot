import * as THREE from 'three';
import { Actor } from './actor';
import { Ally } from './allies';
import type { Assets } from './assets';
import {
  CALM, CARDS, ENEMIES, INTEREST, META, RELICS, TOWERS, WARES, WEAPONS, WEAPON_PRICE, baseUpgrades, callBonus, enemyHp, interestCap, isBossWave,
  warePrice, waveComposition, waveOptions, xpForLevel, type EnemyKind, type RelicId, type Upgrades, type Ware, type WaveOption, type Weapon, type WeaponId,
} from './data';
import { Economy, type FeelEvent, type Pad } from './economy';
import { Fx } from './fx';
import { Hero, type Input } from './hero';
import { ELITES, Horde, besideWall, type Elite, type Enemy } from './horde';
import type { Choice, Hud } from './hud';
import type { MapDef } from './maps';
import { Projectiles } from './projectiles';
import { pick, rand, shuffle } from './rng';
import { save } from './save';
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
const VOLLEY_COOLDOWN = 10;
const VOLLEY_BOLTS = 18;
const BASH_COOLDOWN = 14;
const BASH_RADIUS = 5.5;
const BASH_PUSH = 4.5;
const BASH_STUN = 0.9;
const BASH_DAMAGE = 3;
const WARDEN_RED = 0xb3202c;

interface Merchant { root: THREE.Object3D; actor: Actor; offers: Pad[]; leaveAt: number }

/** Rounds a fractional amount up or down at random, keeping its average. */
const roll = (x: number) => Math.max(1, Math.floor(x) + (rand() < x % 1 ? 1 : 0));

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
  private ranger: Ally | null = null;
  private sellsword: Ally | null = null;
  private merchant: Merchant | null = null;
  private campQueue: Array<{ kind: EnemyKind; x: number; z: number }> = [];
  private hp = 100;
  private upgrades: Upgrades = baseUpgrades();
  private taken = new Map<string, number>();
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
  private onKey = (e: KeyboardEvent) => {
    if (/^Digit[123]$/.test(e.code)) {
      const i = Number(e.code[5]) - 1;
      if (this.offered) this.chooseCard(i); else this.chooseOption(i);
    }
    if (e.code === 'KeyQ' && !e.repeat) this.useAbility(0);
    if (e.code === 'KeyE' && !e.repeat) this.useAbility(1);
    if (e.code === 'KeyC' && !e.repeat) this.callWave();
  };

  constructor(private assets: Assets, private camera: THREE.PerspectiveCamera, private hud: Hud, readonly sfx: Sfx, readonly map: MapDef) {
    this.sun = buildLighting(this.scene, map.look);
    ({ obstacles: this.obstacles, walls: this.walls } = buildWorld(this.scene, assets, map));
    this.updateWeather = buildWeather(this.scene, map.look.weather);

    this.hero = new Hero(assets, this.scene);
    this.hero.setBody('Knight', WARDEN_RED, true);
    this.hero.equip(WEAPONS.crossbow);

    this.economy = new Economy(this.scene, assets, this.obstacles, this.hero.root, {
      nearest: (from, range) => this.horde.nearest(from, range)?.actor.root.position ?? null,
      fire: (from, target, damage, count) => {
        this.sfx.shoot(true);
        this.fx.burst(from.x, from.y, from.z, GOLD, 2, 4, 0.12);
        this.shots.fire(from, target, damage, count, 0);
      },
      lob: (from, target, radius, burn) => this.shots.lob(from, target, radius, burn, TOWERS.catapult.damage + this.upgrades.towerDamage),
      aura: (x, z, radius, damage, slow, freeze) => { this.horde.aura(x, z, radius, damage, slow, freeze); },
      trap: (x, z, radius) => this.horde.trapPulse(x, z, radius),
      upgraded: (text, x, z) => {
        this.sfx.build();
        this.sfx.levelUp();
        this.fx.ring(x, z, GOLD, 6);
        this.fx.burst(x, 2, z, GOLD, 24, 9, 0.2);
        this.fx.shake(0.25);
        this.hud.banner(text);
      },
      keepRaised: (tier, x, z) => {
        this.sfx.levelUp();
        this.fx.ring(x, z, GOLD, 9);
        this.fx.burst(x, 4, z, GOLD, 40, 12, 0.26);
        this.fx.shake(0.4);
        this.upgrades.maxHp += KEEP_HP;
        this.hp = Math.min(this.upgrades.maxHp, this.hp + KEEP_HP);
        this.hud.banner(tier === 2 ? 'Keep II: beacons, cottages, a ranger' : 'Keep III: the mine and tier III towers');
        this.refreshHud();
      },
      onResources: () => this.refreshHud(),
      feel: (event, x, z, progress) => this.feel(event, x, z, progress ?? 0),
    }, this.upgrades, map);

    this.horde = new Horde(this.scene, assets, this.fx, this.sfx, map, this.obstacles, this.economy, {
      hero: () => this.hero.position,
      heroInside: () => this.heroInside,
      speedMul: () => this.current.mod.speed ?? 1,
      hpFor: (kind) => Math.round(enemyHp(kind, Math.max(1, this.wave), this.map) * (1 + this.past * ENDLESS_HP)),
      castOrb: (from, damage, spread) => this.shots.castOrb(from, damage, spread),
      killed: (e) => this.killed(e),
      bossSpawned: () => this.hud.boss(this.map.boss.name),
      bossHealth: (fraction) => this.hud.bossHealth(fraction),
      bossFell: () => { this.hud.boss(null); this.slowmo = BOSS_DEATH_SLOWMO; },
    });
    this.shots = new Projectiles(this.scene, assets, this.fx, this.sfx, {
      pool: () => this.horde.pool,
      damage: (e, amount, dir, quiet) => this.horde.damage(e, amount, dir, quiet),
      hero: () => this.hero.position,
      heroHit: (damage) => {
        this.hurtHero(damage);
        this.showHurt();
        this.refreshHud();
        if (this.hp <= 0 && !this.over) this.endRun(false);
      },
      shake: (amount) => this.fx.shake(amount),
    });
    this.wilds = new Wilds(this.scene, assets, this.obstacles, map.openSides, {
      guards: (site) => this.wakeGuards(site),
      opened: (site) => this.siteOpened(site),
      announce: (text) => this.hud.banner(text),
      padClearance: (x, z) => this.economy.padClearance(x, z),
    });
    addEventListener('keydown', this.onKey);
    hud.abilityLabels([{ title: 'Volley', key: 'Q' }, { title: 'Bash', key: 'E' }]);
    this.reset();
  }

  get weaponId(): WeaponId { return this.hero.weapon.id; }
  get running(): boolean { return this.started && !this.over; }
  /** Waves past the map's last, in endless. */
  private get past(): number { return Math.max(0, this.wave - this.map.waves); }
  private get streakMul(): number { return 1 + Math.min(1, this.streak / STREAK_FULL); }
  private get resting(): boolean {
    return this.running && this.cleared && this.toSpawn.length === 0 && !(this.tutorial?.holdWaves ?? false);
  }

  /** Begins a run on this map. */
  start(): void {
    this.reset();
    this.started = true;
    if (!save.data.tutorialDone && this.map.id === 'greenhollow') this.tutorial = new Tutorial(this.scene);
  }

  setShadows(on: boolean): void { this.sun.castShadow = on; }

  /** Stops play and lets the map idle behind the menu. */
  toMenu(): void {
    this.reset();
    this.started = false;
  }

  /** Frees GPU resources; models shared through Assets are left alone. */
  dispose(): void {
    removeEventListener('keydown', this.onKey);
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
    return pick(Object.values(WEAPONS).filter((w) => w.id !== this.hero.weapon.id));
  }

  reset(): void {
    Object.assign(this.upgrades, baseUpgrades());
    for (const item of META) item.apply(this.upgrades, save.level(item.id));
    this.tutorial?.dispose();
    this.tutorial = null;
    this.paused = false;
    this.taken.clear();
    this.hp = this.upgrades.maxHp;
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
    this.hero.reset();
    this.hero.equip(WEAPONS.crossbow);
    this.camFocus.copy(this.hero.position);
    this.heroInside = true;
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
    this.ranger?.dispose();
    this.ranger = null;
    this.sellsword?.dispose();
    this.sellsword = null;
    if (this.merchant) { this.scene.remove(this.merchant.root); this.merchant = null; }
    this.economy.reset();
    this.economy.grant(this.upgrades.startWood, this.upgrades.startGold);
    this.offerRanger();
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

  // ---- Waves ----

  private startWave(): void {
    const option = this.options?.[this.choice] ?? this.current;
    this.wave++;
    this.current = option;
    this.options = null;
    this.cleared = false;
    this.restTimer = WAVE_REST;
    this.hud.showNext(false);
    this.upgrades.towerRange = option.mod.towerRange ?? 1;
    this.toSpawn = waveComposition(this.wave, this.map, option.mod, option.horde * (1 + this.past * ENDLESS_HORDE));
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
    this.upgrades.towerRange = 1;
    const heal = Math.round(this.upgrades.maxHp * WAVE_CLEAR_HEAL);
    this.hp = Math.min(this.upgrades.maxHp, this.hp + heal);
    const rent = this.economy.waveCleared();
    const interest = Math.min(interestCap(this.wave), Math.floor(this.economy.gold * INTEREST));
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
    if (isBossWave(this.wave, this.map)) this.pendingRelic = RELICS.some((r) => !this.relics.has(r.id));
    this.wilds.waveCleared(this.wave);
    this.refreshHud();
    if (this.wave >= this.map.waves && !this.endless) { this.endRun(true); return; }
    if (!this.merchant && this.wave % MERCHANT_EVERY === 0) this.merchantArrives();
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

  /** Starts the next wave now, paying gold for the time skipped. */
  callWave(): void {
    if (!this.resting || this.paused || this.offered || !this.options) return;
    const bonus = callBonus(this.restTimer, this.wave + 1);
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
    this.hud.countdown(seconds, `${boss ? `Wave ${next}: the ${this.map.boss.name}` : `Wave ${next}`} in ${seconds}s`, `Call now  +${callBonus(this.restTimer, next)} gold`);
  }

  private spawnOne(): boolean {
    const kind = this.toSpawn[this.toSpawn.length - 1];
    const side = pick(this.map.openSides);
    const [nx, nz] = GATE_SIDES[side];
    const dist = CAMP + 6 + rand() * 6;
    const lateral = (rand() - 0.5) * 6;
    const e = this.horde.spawn(kind, nx * dist + nz * lateral, nz * dist + nx * lateral, side, false);
    if (!e) return false;
    this.toSpawn.pop();
    const eliteMul = this.current.mod.elites ?? 1;
    if (kind !== 'Boss' && kind !== 'Hexer' && this.wave >= (eliteMul > 1 ? 2 : ELITE_WAVE) && rand() < ELITE_CHANCE * eliteMul) {
      this.horde.makeElite(e, pick(Object.keys(ELITES) as Elite[]));
    }
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
    this.restTimer = WAVE_REST;
    if (!this.merchant) this.merchantArrives();
    this.refreshHud();
  }

  private endRun(won: boolean): void {
    this.over = true;
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
    if (this.endless) {
      const held = Math.max(0, this.wave - 1 - this.map.waves);
      const banked = save.recordEndless(this.map, this.wave - 1, held * ENDLESS_PAY);
      this.hud.over('The last stand ends', `You held ${held} endless ${held === 1 ? 'wave' : 'waves'}, to wave ${this.wave}, and slew ${this.kills} foes. ${banked} gold added to the treasury.`, false);
      return;
    }
    const banked = save.recordRun(this.map, won, this.wave, this.economy.gold);
    let score = won
      ? `All ${this.map.waves} waves repelled. ${this.kills} foes slain in ${minutes}:${seconds}, at level ${this.level}.`
      : `You held until wave ${this.wave} and slew ${this.kills} foes, at level ${this.level}.`;
    score += ` ${banked} gold added to the treasury.`;
    if (won) score += ' Press on for endless waves?';
    this.hud.over(won ? 'The hamlet stands' : 'The hamlet has fallen', score, won);
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
    const pool = shuffle(WARES.filter((w) => (w.id !== 'mason' || this.economy.canFreeUpgrade) && (w.id !== 'sellsword' || !this.sellsword)));
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
  private offerRanger(): void {
    const k = this.economy.keepSpot;
    const at = this.economy.spotNear(k.x, k.z, [4.4, 5.6]);
    this.economy.offer({
      x: at.x, z: at.z, title: 'Hire a Ranger', blurb: 'An archer who follows you', wood: 10, gold: 30, minTier: 2,
      buy: () => {
        if (!this.ranger) {
          this.ranger = new Ally(this.scene, this.assets, 'Ranger', 'bow_withString', 0, this.obstacles);
          this.ranger.place(at.x, at.z);
          this.hud.banner('A ranger joins you');
          return { title: 'Ranger II', blurb: 'Shoots 40% faster', wood: 0, gold: 35, minTier: 2 };
        }
        this.ranger.level++;
        this.hud.banner(`Ranger ${this.ranger.level === 2 ? 'II' : 'III'}`);
        return this.ranger.level === 2 ? { title: 'Ranger III', blurb: 'Twin arrows, +1 damage', wood: 0, gold: 55, minTier: 3 } : null;
      },
    });
  }

  private updateAllies(dt: number): void {
    const ctx = {
      hero: this.hero.position,
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
      : ['Minion', 'Minion', 'Minion', 'Warrior', ...(w >= 8 ? ['Hexer' as const] : [])];
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
      this.economy.grant(12, 20 + w * 4);
      this.fx.shake(0.4);
      this.hud.banner(`Camp razed: +${20 + w * 4} gold, +12 wood`);
      return;
    }
    const r = rand();
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

  /** Takes damage on the hero, softened by armour; ends the kill streak. */
  private hurtHero(amount: number): void {
    const dealt = amount * this.upgrades.armor;
    this.hp -= dealt;
    this.hurtBank += dealt;
    if (this.streak > 0) { this.streak = 0; this.refreshHud(); }
    if (this.relics.has('ward') && this.elapsed >= this.wardReady) {
      this.wardReady = this.elapsed + WARD_GAP;
      const p = this.hero.position;
      this.horde.aura(p.x, p.z, WARD_RADIUS, 1, 0.4, true);
    }
  }

  /** Damage arrives every frame, so it is shown in small bundles. */
  private showHurt(): void {
    this.hurtTimer = HURT_GAP;
    const p = this.hero.position;
    this.hero.actor.flash();
    this.sfx.hurt();
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
    const p = e.actor.root.position;
    const reward = (e.elite ? 3 : 1) * this.streakMul * this.upgrades.goldMul * (this.current.mod.gold ?? 1);
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

  private updateHero(dt: number, input: Input): void {
    const p = this.hero.position;
    const chopping = this.economy.update(dt, p);
    if (this.upgrades.regen > 0 && this.hp < this.upgrades.maxHp) {
      this.hp = Math.min(this.upgrades.maxHp, this.hp + this.upgrades.regen * dt);
      this.refreshHud();
    }
    const moving = this.hero.move(dt, input, this.upgrades.speed, this.obstacles);
    if (moving && this.relics.has('embers')) {
      this.emberTimer -= dt;
      if (this.emberTimer <= 0) { this.emberTimer = EMBER_GAP; this.shots.ignite(p.x, p.z, EMBER_RADIUS, 1.6); }
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
          this.cleave(p, reach, this.upgrades.damage * w.damage + this.upgrades.pierce * 0.6);
        } else {
          this.sfx.shoot();
          const chain = this.relics.has('storm') && ++this.shotsFired % STORM_EVERY === 0;
          this.shots.fire(p.clone().setY(1.7), tp, roll(this.upgrades.damage * w.damage), this.upgrades.arrows, this.upgrades.pierce + w.pierce, chain);
        }
      }
    }
    if (face !== null) this.hero.face(face, dt);
    this.hero.animate(dt, moving, chopping, this.elapsed);
  }

  /** The greataxe: one sweeping blow at every foe within reach. */
  private cleave(p: THREE.Vector3, reach: number, damage: number): void {
    this.horde.cleave(p, reach, roll(damage));
    this.sfx.boulder();
    this.fx.ring(p.x, p.z, 0xffe0b0, reach);
    this.fx.burst(p.x, 1, p.z, 0xffe0b0, 10, 8, 0.16);
  }

  /** 0 fires a ring of bolts; 1 bashes nearby foes away and stuns them. */
  useAbility(index: number): void {
    if (!this.running || this.paused || this.offered || this.abilityCooldown[index] > 0) return;
    const p = this.hero.position;
    if (index === 0) {
      this.abilityCooldown[0] = VOLLEY_COOLDOWN;
      const from = p.clone().setY(1.6);
      for (let i = 0; i < VOLLEY_BOLTS; i++) {
        const a = (i / VOLLEY_BOLTS) * Math.PI * 2;
        this.shots.fire(from, new THREE.Vector3(p.x + Math.cos(a) * 10, 1.5, p.z + Math.sin(a) * 10), this.upgrades.damage + 1, 1, 1);
      }
      this.sfx.shoot();
      this.fx.ring(p.x, p.z, GOLD, 5);
      this.fx.shake(0.15);
    } else {
      this.abilityCooldown[1] = BASH_COOLDOWN;
      this.horde.bash(p, BASH_RADIUS, BASH_PUSH, BASH_STUN, BASH_DAMAGE);
      this.sfx.boulder();
      this.fx.ring(p.x, p.z, 0xffffff, BASH_RADIUS);
      this.fx.burst(p.x, 0.5, p.z, DUST, 26, 10, 0.26);
      this.fx.shake(0.35);
    }
  }

  private updateAbilities(dt: number): void {
    for (let i = 0; i < 2; i++) {
      this.abilityCooldown[i] = Math.max(0, this.abilityCooldown[i] - dt / this.upgrades.cooldown);
      const full = i === 0 ? VOLLEY_COOLDOWN : BASH_COOLDOWN;
      this.hud.abilityCooldown(i, this.abilityCooldown[i] / full);
    }
  }

  private updateEnemies(dt: number): void {
    this.heroInside = besideWall(this.hero.position, this.heroInside);
    const touching = this.horde.update(dt);
    if (touching > 0) {
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

  /** Offers three relics not yet held, after a boss falls. */
  private showRelics(): void {
    this.pendingRelic = false;
    const open = shuffle(RELICS.filter((r) => !this.relics.has(r.id))).slice(0, 3);
    if (open.length === 0) return;
    this.present(`The ${this.map.boss.name} has fallen: claim a relic`, open.map((r) => ({
      title: r.title, text: r.text,
      pick: () => { this.relics.add(r.id); r.apply?.(this.upgrades); this.hud.banner(r.title); },
    })));
  }

  private showCards(): void {
    const open = CARDS.filter((c) => (this.taken.get(c.id) ?? 0) < c.max);
    if (open.length === 0) { this.pendingCards = 0; return; }
    const picked = shuffle([...open]).slice(0, 3);
    this.present('Choose a boon', picked.map((card) => ({
      title: card.title, text: card.text,
      pick: () => {
        this.pendingCards--;
        card.apply(this.upgrades);
        this.taken.set(card.id, (this.taken.get(card.id) ?? 0) + 1);
        if (card.id === 'vitality') this.hp += 25;
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
      weapon: this.hero.weapon.id, relics: [...this.relics].join(), ranger: this.ranger?.level ?? 0, sellsword: !!this.sellsword, merchant: !!this.merchant,
      camps: this.wilds.camps.length, sites: this.wilds.all.length, streak: this.streak, endless: this.endless, mod: this.current.mod.id,
      hp: this.hp, wave: this.wave, kills: this.kills, active: this.horde.activeCount, over: this.over, level: this.level, cards: this.offered?.length ?? 0, ...this.economy.stats,
    };
  }
}
