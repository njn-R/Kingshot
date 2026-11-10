import * as THREE from 'three';
import { Actor } from './actor';
import type { Assets } from './assets';
import { Ally } from './allies';
import { Economy, type FeelEvent, type Pad, type Structure } from './economy';
import { Fx } from './fx';
import type { Sfx } from './sfx';
import { save } from './save';
import { Tutorial } from './tutorial';
import {
  CALM, CARDS, ENEMIES, META, RELICS, TOWERS, WARES, WEAPONS, WEAPON_PRICE, baseUpgrades, enemyHp, isBossWave, warePrice, waveComposition, waveOptions, xpForLevel,
  type EnemyKind, type RangedAttack, type RelicId, type Upgrades, type Ware, type WaveOption, type Weapon, type WeaponId,
} from './data';
import type { MapDef } from './maps';
import { Wilds, normalized, type Site } from './wilds';
import { CAMP, GATE_SIDES, WORLD_LIMIT, buildLighting, buildWeather, buildWorld, collideWalls, insideCamp, type Obstacle, type WallFade } from './world';

const ARROW_SPEED = 42;
const ARROW_SCALE = 2.2;
const CHAR_SCALE = 1.1;
const FIRST_WAVE_DELAY = 14;
const WAVE_REST = 15;
/** Share of unspent gold paid as interest after a wave, up to a cap that grows with the wave. */
const INTEREST = 0.1;
const interestCap = (wave: number) => 5 + wave * 2;
/** Gold per second skipped when calling a wave early. */
const callBonus = (seconds: number, wave: number) => Math.round(seconds * (0.8 + wave * 0.1));
/** Kills without being hurt that double the gold foes drop. */
const STREAK_FULL = 50;
const MERCHANT_EVERY = 3;
const MERCHANT_STAY = 2;
const EMBER_GAP = 0.3;
const EMBER_RADIUS = 1.7;
const STORM_EVERY = 5;
const STORM_TARGETS = 3;
const STORM_RANGE = 7;
const WARD_GAP = 6;
const WARD_RADIUS = 6;
const KEEP_HP = 20;
/** Each endless wave adds this much health, and this much horde, to every foe and wave. */
const ENDLESS_HP = 0.14;
const ENDLESS_HORDE = 0.06;
const ENDLESS_PAY = 25;
const RAIDER_CHANCE = 0.3;
const WAVE_CLEAR_HEAL = 0.3;
const CARD_SPREAD = 0.16;
const TRAIL_LENGTH = 3.2;
const KNOCKBACK = 0.14;
const HURT_GAP = 0.3;
const BOSS_DEATH_SLOWMO = 0.55;
const SLOWMO_RATE = 0.2;
const LOW_HP = 0.3;
const BONE = 0xe9e1c9;
const WOOD = 0x9a6233;
const DUST = 0xb9a584;
const GOLD = 0xffd24a;
const ORB_SPEED = 13;
const ORB_LIFE = 2.2;
const BOULDER_FLIGHT = 0.8;
const BOULDER_ARC = 9;
const BURN_TIME = 3;
const BURN_RADIUS = 3;
const BURN_TICK = 0.5;
const FREEZE_TIME = 1.2;
const THORN_DPS = 3;
const SLOW_TIME = 1;
const CAST_TIME = 0.6;
/** Half-width of the lane through a gate that walkers line up in. */
const GATE_LANE = 2.2;
const STUCK_LIMIT = 6;
const ELITE_WAVE = 4;
const ELITE_CHANCE = 0.08;
const VOLLEY_COOLDOWN = 10;
const VOLLEY_BOLTS = 18;
const BASH_COOLDOWN = 14;
const BASH_RADIUS = 5.5;
const BASH_PUSH = 4.5;
const BASH_STUN = 0.9;
const BASH_DAMAGE = 3;
const TRAP_SLOW = 0.6;

type Elite = 'swift' | 'armored' | 'splitting';
const ELITES: Record<Elite, { glow: number; label: string }> = {
  swift: { glow: 0x30c8ff, label: 'Swift' },
  armored: { glow: 0xffb020, label: 'Armored' },
  splitting: { glow: 0x60ff70, label: 'Splitting' },
};
const ARROW_SECTORS = 16;
const ARROW_MARGIN = 30;

const orbGeometry = new THREE.IcosahedronGeometry(0.42, 1);
const orbMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 0.7, 2.6), toneMapped: false });
const boulderGeometry = new THREE.IcosahedronGeometry(0.62, 0);
const boulderMaterial = new THREE.MeshStandardMaterial({ color: 0x8b8580, roughness: 0.95, flatShading: true });
const NO_PUSH = new THREE.Vector3();

/** Inside or outside the camp, changing only once clearly past the wall line, so standing in a gateway doesn't flicker. */
const besideWall = (p: { x: number; z: number }, wasInside: boolean): boolean => {
  const d = Math.max(Math.abs(p.x), Math.abs(p.z));
  return wasInside ? d < CAMP + 1 : d < CAMP - 1;
};

interface Enemy {
  actor: Actor;
  kind: EnemyKind;
  alive: boolean;
  active: boolean;
  hp: number;
  timer: number; // spawn delay, then corpse timer
  side: number;
  inside: boolean;
  /** Where it last made real progress, and for how long it has been stuck near there. */
  anchorX: number;
  anchorZ: number;
  stuckFor: number;
  animDt: number;
  cooldown: number; // time until the next ranged attack
  slowUntil: number;
  slowFactor: number;
  frozenUntil: number;
  /** Damage owed by a spiked gate, paid out in whole points. */
  thorn: number;
  elite: Elite | null;
  summonTimer: number;
  /** Guards of a forest site; they don't hold up the next wave. */
  wild: boolean;
  /** Raiders outside the walls go for the mine. */
  raider: boolean;
  target: Structure | null;
  retarget: number;
}

interface Orb { mesh: THREE.Mesh; dir: THREE.Vector3; life: number; damage: number }
interface Boulder { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number; damage: number; radius: number; burn: boolean }
interface Fire { mesh: THREE.Mesh; x: number; z: number; r: number; life: number; tick: number }
interface Choice { title: string; text: string; pick(): void }
interface Merchant { root: THREE.Object3D; actor: Actor; offers: Pad[]; leaveAt: number }

const fireGeometry = new THREE.CircleGeometry(BURN_RADIUS, 32).rotateX(-Math.PI / 2);
const fireMaterial = new THREE.MeshBasicMaterial({ color: 0xff6a20, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false });

interface Arrow { obj: THREE.Object3D; trail: THREE.Object3D; travelled: number; dir: THREE.Vector3; life: number; damage: number; pierce: number; hit: Set<Enemy>; chain: boolean }

/** Rounds a fractional amount up or down at random, keeping its average. */
const roll = (x: number) => Math.max(1, Math.floor(x) + (Math.random() < x % 1 ? 1 : 0));

export interface Input { x: number; z: number }

export class Game {
  readonly scene = new THREE.Scene();
  private started = false;
  private tutorial: Tutorial | null = null;
  paused = false;
  private orbit = 0;
  private orbs: Orb[] = [];
  private boulders: Boulder[] = [];
  private fires: Fire[] = [];
  private updateWeather: (dt: number, focus: THREE.Vector3) => void;
  private onKey = (e: KeyboardEvent) => {
    if (/^Digit[123]$/.test(e.code)) {
      const i = Number(e.code[5]) - 1;
      if (this.offered) this.chooseCard(i); else this.chooseOption(i);
    }
    if (e.code === 'KeyQ' && !e.repeat) this.useAbility(0);
    if (e.code === 'KeyE' && !e.repeat) this.useAbility(1);
    if (e.code === 'KeyC' && !e.repeat) this.callWave();
  };
  private endless = false;
  private options: [WaveOption, WaveOption] | null = null;
  private choice = 0;
  private current: WaveOption = { mod: CALM, horde: 1, gold: 0, boon: false };
  private cleared = true;
  private shownRest = -1;
  private streak = 0;
  private relics = new Set<RelicId>();
  private pendingRelic = false;
  private weapon: Weapon = WEAPONS.crossbow;
  private held: THREE.Object3D | null = null;
  private ranger: Ally | null = null;
  private sellsword: Ally | null = null;
  private merchant: Merchant | null = null;
  private wilds: Wilds;
  private campQueue: Array<{ kind: EnemyKind; x: number; z: number }> = [];
  private shots = 0;
  private emberTimer = 0;
  private wardReady = 0;
  private siteArrows: Array<{ root: HTMLElement; arrow: HTMLElement }> = [];
  private abilityCooldown = [0, 0];
  private shownCooldown = [-1, -1];
  private edgeArrows: Array<{ root: HTMLElement; arrow: HTMLElement; count: HTMLElement }> = [];
  private projected = new THREE.Vector3();
  private fx = new Fx(this.scene);
  private hurtFlash = 0;
  private hurtTimer = 0;
  private hurtBank = 0;
  private slowmo = 0;
  private hero: Actor;
  private economy: Economy;
  private sun: THREE.DirectionalLight;
  private obstacles: Obstacle[];
  private walls: WallFade;
  private pool: Enemy[] = [];
  private arrows: Arrow[] = [];
  private arrowModel: THREE.Object3D;
  private fireTimer = 0;
  private hp = 100;
  private upgrades: Upgrades = baseUpgrades();
  private taken = new Map<string, number>();
  private xp = 0;
  private level = 1;
  private pendingCards = 0;
  private offered: Choice[] | null = null;
  private boss: Enemy | null = null;
  private bossMax = 1;
  private elapsed = 0;
  private frame = 0;
  private kills = 0;
  private wave = 0;
  private toSpawn: EnemyKind[] = [];
  private spawnTimer = 0;
  private restTimer = FIRST_WAVE_DELAY;
  private bannerTimer = 0;
  private over = false;
  private camFocus = new THREE.Vector3();
  private heroInside = true;
  private cape = new THREE.Group();

  constructor(private assets: Assets, private camera: THREE.PerspectiveCamera, private ui: {
    title: HTMLElement; xp: HTMLElement; level: HTMLElement; boss: HTMLElement; bossFill: HTMLElement; cards: HTMLElement; hp: HTMLElement; wood: HTMLElement; gold: HTMLElement; wave: HTMLElement; kills: HTMLElement; banner: HTMLElement; over: HTMLElement; score: HTMLElement; hurt: HTMLElement;
    bossName: HTMLElement; abilities: [HTMLElement, HTMLElement]; arrows: HTMLElement;
    next: HTMLElement; nextTitle: HTMLElement; nextOpts: HTMLElement; callNow: HTMLElement; streak: HTMLElement; endless: HTMLElement;
  }, readonly sfx: Sfx, readonly map: MapDef) {
    this.sun = buildLighting(this.scene, map.look);
    ({ obstacles: this.obstacles, walls: this.walls } = buildWorld(this.scene, assets, map));
    this.updateWeather = buildWeather(this.scene, map.look.weather);

    this.hero = new Actor(assets, 'Knight', CHAR_SCALE);
    this.scene.add(this.hero.root);
    this.equip(WEAPONS.crossbow);
    this.dressWarden();

    this.arrowModel = this.makeArrowModel();
    this.economy = new Economy(this.scene, assets, this.obstacles, this.hero.root, {
      nearest: (from, range) => this.nearestEnemy(from, range)?.actor.root.position ?? null,
      fire: (from, target, damage, count) => {
        this.sfx.shoot(true);
        this.fx.burst(from.x, from.y, from.z, GOLD, 2, 4, 0.12);
        this.fire(from, target, damage, count, 0);
      },
      lob: (from, target, radius, burn) => this.lob(from, target, radius, burn),
      aura: (x, z, radius, damage, slow, freeze) => this.aura(x, z, radius, damage, slow, freeze),
      trap: (x, z, radius) => this.trapPulse(x, z, radius),
      upgraded: (text, x, z) => {
        this.sfx.build();
        this.sfx.levelUp();
        this.fx.ring(x, z, GOLD, 6);
        this.fx.burst(x, 2, z, GOLD, 24, 9, 0.2);
        this.fx.shake(0.25);
        this.showBanner(text);
      },
      keepRaised: (tier, x, z) => {
        this.sfx.levelUp();
        this.fx.ring(x, z, GOLD, 9);
        this.fx.burst(x, 4, z, GOLD, 40, 12, 0.26);
        this.fx.shake(0.4);
        this.upgrades.maxHp += KEEP_HP;
        this.hp = Math.min(this.upgrades.maxHp, this.hp + KEEP_HP);
        this.showBanner(tier === 2 ? 'Keep II: beacons, cottages, a ranger' : 'Keep III: the mine and tier III towers');
        this.refreshHud();
      },
      onResources: () => this.refreshHud(),
      feel: (event, x, z, progress) => this.feel(event, x, z, progress ?? 0),
    }, this.upgrades, map);
    this.wilds = new Wilds(this.scene, assets, this.obstacles, map.openSides, {
      guards: (site) => this.wakeGuards(site),
      opened: (site) => this.siteOpened(site),
      announce: (text) => this.showBanner(text),
      padClearance: (x, z) => this.economy.padClearance(x, z),
    });
    addEventListener('keydown', this.onKey);
    ui.arrows.replaceChildren();
    for (let i = 0; i < 12; i++) {
      const root = document.createElement('div');
      root.className = 'edge';
      const arrow = document.createElement('i');
      const count = document.createElement('b');
      root.append(arrow, count);
      ui.arrows.append(root);
      this.edgeArrows.push({ root, arrow, count });
    }
    for (let i = 0; i < 6; i++) {
      const root = document.createElement('div');
      root.className = 'edge site';
      const arrow = document.createElement('i');
      root.append(arrow);
      ui.arrows.append(root);
      this.siteArrows.push({ root, arrow });
    }
    this.reset();
  }

  /** Puts a weapon in the hero's hand; its stats apply from the next shot. */
  private equip(weapon: Weapon): void {
    this.weapon = weapon;
    let hand: THREE.Object3D | undefined;
    this.hero.root.traverse((o) => { if (/^handslot\.?r$/i.test(o.name)) hand = o; });
    if (!hand) { console.warn('Hero hand bone not found'); return; }
    if (this.held) this.held.parent?.remove(this.held);
    const model = this.assets.scene(weapon.model).clone();
    model.traverse((o) => { o.castShadow = (o as THREE.Mesh).isMesh; });
    hand.add(model);
    this.held = model;
  }

  get weaponId(): WeaponId { return this.weapon.id; }

  /** A weapon the hero doesn't carry, for chests and the merchant. */
  private otherWeapon(): Weapon {
    const others = Object.values(WEAPONS).filter((w) => w.id !== this.weapon.id);
    return others[Math.floor(Math.random() * others.length)];
  }

  /** Begins a run on this map. */
  start(): void {
    this.reset();
    this.started = true;
    if (!save.data.tutorialDone && this.map.id === 'greenhollow') this.tutorial = new Tutorial(this.scene);
  }

  get running(): boolean { return this.started && !this.over; }

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

  /** Gives the stock knight a cape and crest, so the hero is this game's own Warden. */
  private dressWarden(): void {
    const crimson = new THREE.MeshStandardMaterial({ color: 0xb3202c, roughness: 0.75, side: THREE.DoubleSide });
    const geometry = new THREE.PlaneGeometry(1.05, 1.55, 6, 8).translate(0, -0.78, 0);
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = -pos.getY(i) / 1.55;
      pos.setX(i, pos.getX(i) * (0.72 + k * 0.5));
      pos.setZ(i, Math.sin(pos.getX(i) * 5) * 0.05 * k);
    }
    geometry.computeVertexNormals();
    const cape = new THREE.Mesh(geometry, crimson);
    cape.castShadow = true;
    this.cape.position.set(0, 1.55, -0.3);
    this.cape.add(cape);
    this.hero.root.add(this.cape);

    let head: THREE.Object3D | undefined;
    this.hero.root.traverse((o) => { if (/^head$/i.test(o.name)) head = o; });
    if (!head) { console.warn('Hero head bone not found'); return; }
    const gold = new THREE.MeshStandardMaterial({ color: 0xe6b84a, roughness: 0.4, metalness: 0.6 });
    const crest = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.7), gold);
    crest.add(base);
    for (let i = 0; i < 5; i++) {
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.62 - i * 0.05, 5), crimson);
      fin.position.set(0, 0.28, 0.3 - i * 0.16);
      fin.rotation.x = -0.3 - i * 0.12;
      crest.add(fin);
    }
    this.hero.root.updateMatrixWorld(true);
    const at = head.getWorldPosition(new THREE.Vector3());
    this.hero.root.add(crest);
    crest.position.set(0, (at.y - this.hero.root.position.y) / CHAR_SCALE + 1.08, 0);
    this.hero.root.updateMatrixWorld(true);
    head.attach(crest);
  }

  /** Wraps the arrow so its long axis points along +Z. */
  private makeArrowModel(): THREE.Object3D {
    const src = this.assets.scene('arrow_bow').clone();
    const size = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
    if (size.y >= size.x && size.y >= size.z) src.rotation.x = Math.PI / 2;
    else if (size.x >= size.z) src.rotation.y = Math.PI / 2;
    const wrap = new THREE.Group();
    wrap.add(src);
    wrap.scale.setScalar(ARROW_SCALE);

    // A streak behind the bolt, bright at the head and fading to nothing at the tail.
    const length = TRAIL_LENGTH / ARROW_SCALE;
    const geometry = new THREE.BoxGeometry(0.05, 0.05, length).translate(0, 0, -length / 2);
    const z = geometry.getAttribute('position');
    const colors = new Float32Array(z.count * 3);
    for (let i = 0; i < z.count; i++) {
      const k = 1 + z.getZ(i) / length;
      colors.set([k, k * 0.82, k * 0.5], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const trail = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
    }));
    trail.name = 'trail';
    wrap.add(trail);
    return wrap;
  }

  private feel(event: FeelEvent, x: number, z: number, progress: number): void {
    switch (event) {
      case 'chop':
        this.sfx.chop();
        this.fx.burst(x, 1.8, z, WOOD, 5, 6, 0.18);
        this.bump(this.ui.wood);
        break;
      case 'fell':
        this.sfx.fell();
        this.fx.burst(x, 2, z, 0x5f8a3a, 14, 8, 0.24);
        this.fx.shake(0.15);
        break;
      case 'coin':
        this.sfx.coin();
        this.fx.burst(x, 1, z, GOLD, 3, 4, 0.12);
        this.bump(this.ui.gold);
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
        this.bump(this.ui.wood);
        break;
      case 'mined':
        this.sfx.coin();
        this.fx.number(x, 4, z, `+${progress} gold`, '#ffd24a', 0.9);
        this.fx.burst(x, 2, z, GOLD, 5, 4, 0.14);
        this.bump(this.ui.gold);
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
        this.showBanner(insideCamp({ x, z }) ? 'A cottage was razed' : 'The mine was overrun');
        break;
      case 'gateBreak':
        this.sfx.gateBreak();
        this.fx.burst(x, 2, z, WOOD, 40, 12, 0.32);
        this.fx.shake(0.55);
        this.showBanner('The barricade fell');
        break;
    }
  }

  private bump(el: HTMLElement): void {
    el.animate([{ transform: 'scale(1.22)' }, { transform: 'scale(1)' }], { duration: 130 });
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
    this.hideCards();
    this.setBoss(null);
    this.elapsed = 0;
    this.kills = 0;
    this.wave = 0;
    this.toSpawn = [];
    this.restTimer = FIRST_WAVE_DELAY;
    this.fireTimer = 0;
    this.over = false;
    this.fx.clear();
    this.hurtFlash = this.hurtTimer = this.hurtBank = this.slowmo = 0;
    this.ui.hurt.style.opacity = '0';
    this.ui.over.style.display = 'none';
    for (const e of this.pool) this.release(e);
    for (const a of this.arrows) this.scene.remove(a.obj);
    this.arrows = [];
    for (const o of this.orbs) this.scene.remove(o.mesh);
    this.orbs = [];
    for (const b of this.boulders) this.scene.remove(b.mesh);
    this.boulders = [];
    for (const f of this.fires) this.scene.remove(f.mesh);
    this.fires = [];
    this.abilityCooldown = [0, 0];
    for (const a of this.edgeArrows) a.root.style.display = 'none';
    for (const a of this.siteArrows) a.root.style.display = 'none';
    this.hero.reset();
    this.hero.play('Idle_A');
    this.hero.root.position.set(0, 0, 2);
    this.hero.root.rotation.y = 0;
    this.camFocus.copy(this.hero.root.position);
    this.endless = false;
    this.options = null;
    this.choice = 0;
    this.current = { mod: CALM, horde: 1, gold: 0, boon: false };
    this.cleared = true;
    this.shownRest = -1;
    this.streak = 0;
    this.relics.clear();
    this.pendingRelic = false;
    this.campQueue = [];
    this.shots = 0;
    this.emberTimer = 0;
    this.wardReady = 0;
    this.equip(WEAPONS.crossbow);
    this.ranger?.dispose();
    this.ranger = null;
    this.sellsword?.dispose();
    this.sellsword = null;
    if (this.merchant) { this.scene.remove(this.merchant.root); this.merchant = null; }
    this.showNext(false);
    this.ui.endless.style.display = 'none';
    this.economy.reset();
    this.economy.grant(this.upgrades.startWood, this.upgrades.startGold);
    this.offerRanger();
    this.wilds.reset();
    this.refreshHud();
  }

  private get streakMul(): number { return 1 + Math.min(1, this.streak / STREAK_FULL); }

  private refreshHud(): void {
    this.ui.hp.style.width = `${Math.max(0, this.hp / this.upgrades.maxHp) * 100}%`;
    this.ui.xp.style.width = `${(this.xp / xpForLevel(this.level)) * 100}%`;
    this.ui.level.textContent = `Lv ${this.level}`;
    this.ui.wave.textContent = this.wave === 0 ? '' : this.endless ? `Wave ${this.wave} · Endless` : `Wave ${this.wave}/${this.map.waves}`;
    const mul = this.streakMul;
    this.ui.streak.textContent = mul >= 1.1 ? `×${mul.toFixed(1)}` : '';
    this.ui.kills.textContent = `Slain ${this.kills}`;
    this.ui.wood.textContent = `${this.economy.wood}`;
    this.ui.gold.textContent = `${this.economy.gold}`;
  }

  private release(e: Enemy): void {
    e.active = false;
    e.alive = false;
    e.actor.reset();
    this.scene.remove(e.actor.root);
  }

  private acquire(kind: EnemyKind): Enemy | null {
    let e = this.pool.find((p) => !p.active && p.kind === kind);
    if (!e) {
      const stats = ENEMIES[kind];
      if (this.pool.filter((p) => p.kind === kind).length >= stats.cap) return null;
      const model = kind === 'Boss' ? this.map.boss.model : stats.model;
      e = { actor: new Actor(this.assets, model, stats.scale, true), kind, elite: null, summonTimer: 0, wild: false, raider: false, target: null, retarget: 0, alive: false, active: false, hp: 0, timer: 0, side: 0, inside: false, anchorX: 0, anchorZ: 0, stuckFor: 0, animDt: 0, cooldown: 0, slowUntil: 0, slowFactor: 1, frozenUntil: 0, thorn: 0 };
      this.pool.push(e);
    }
    return e;
  }

  private startWave(): void {
    const option = this.options?.[this.choice] ?? this.current;
    this.wave++;
    this.current = option;
    this.options = null;
    this.cleared = false;
    this.restTimer = WAVE_REST;
    this.showNext(false);
    this.upgrades.towerRange = option.mod.towerRange ?? 1;
    const past = Math.max(0, this.wave - this.map.waves);
    this.toSpawn = waveComposition(this.wave, this.map, option.mod, option.horde * (1 + past * ENDLESS_HORDE));
    // Every standing camp sends its own band from the woods.
    for (const camp of this.wilds.camps) {
      const kinds: EnemyKind[] = Array<EnemyKind>(1 + Math.floor(this.wave * 0.3)).fill('Minion');
      if (this.wave >= 6) kinds.push('Warrior');
      for (const kind of kinds) this.campQueue.push({ kind, x: camp.x + (Math.random() - 0.5) * 4, z: camp.z + (Math.random() - 0.5) * 4 });
    }
    this.spawnTimer = 0;
    const boss = isBossWave(this.wave, this.map);
    const twist = option.mod === CALM ? '' : `: ${option.mod.title}`;
    this.showBanner(boss ? `The ${this.map.boss.name} comes${twist}` : `Wave ${this.wave}${twist}`);
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
    const p = this.hero.root.position;
    this.sfx.cleared();
    this.showBanner(this.current.boon ? 'Wave cleared: a boon earned' : 'Wave cleared');
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

  private get resting(): boolean {
    return this.running && this.cleared && this.toSpawn.length === 0 && !(this.tutorial?.holdWaves ?? false);
  }

  /** Lays out the two ways the next wave can go. */
  private prepareOptions(): void {
    this.options = waveOptions(this.wave + 1);
    this.choice = 0;
    this.shownRest = -1;
    const box = this.ui.nextOpts;
    box.replaceChildren();
    if (this.wave > 0) {
      this.options.forEach((o, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'opt';
        const head = document.createElement('strong');
        head.textContent = i === 0 ? 'Hold steady' : 'Raise the stakes';
        const twist = document.createElement('span');
        twist.textContent = o.horde > 1 ? `${o.mod.title}: ${o.mod.text.toLowerCase()}, bigger horde` : `${o.mod.title}: ${o.mod.text.toLowerCase()}`;
        const pay = document.createElement('em');
        pay.textContent = o.boon ? 'Reward: a boon' : `Reward: ${o.gold} gold`;
        b.append(head, twist, pay);
        b.addEventListener('click', () => this.chooseOption(i));
        box.append(b);
      });
    }
    this.markChoice();
    this.showNext(true);
  }

  /** The next-wave panel; banners move down out of its way while it shows. */
  private showNext(shown: boolean): void {
    this.ui.next.style.display = shown ? 'flex' : 'none';
    document.body.classList.toggle('resting', shown);
  }

  private markChoice(): void {
    [...this.ui.nextOpts.children].forEach((b, i) => b.classList.toggle('chosen', i === this.choice));
  }

  chooseOption(index: number): void {
    if (!this.options || this.wave === 0 || index > 1) return;
    this.choice = index;
    this.sfx.pick();
    this.markChoice();
  }

  /** Starts the next wave now, paying gold for the time skipped. */
  callWave(): void {
    if (!this.resting || this.paused || this.offered || !this.options) return;
    const bonus = callBonus(this.restTimer, this.wave + 1);
    if (bonus > 0) {
      this.economy.grant(0, bonus);
      const p = this.hero.root.position;
      this.fx.number(p.x, 3.6, p.z, `+${bonus} gold`, '#ffd24a', 1.2);
      this.bump(this.ui.gold);
    }
    this.startWave();
  }

  private updateNextPanel(): void {
    const seconds = Math.ceil(this.restTimer);
    if (seconds === this.shownRest) return;
    this.shownRest = seconds;
    const next = this.wave + 1;
    const boss = isBossWave(next, this.map);
    this.ui.nextTitle.textContent = `${boss ? `Wave ${next}: the ${this.map.boss.name}` : `Wave ${next}`} in ${seconds}s`;
    this.ui.callNow.textContent = `Call now  +${callBonus(this.restTimer, next)} gold`;
  }

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
    const pool = WARES.filter((w) => (w.id !== 'mason' || this.economy.canFreeUpgrade) && (w.id !== 'sellsword' || !this.sellsword));
    pool.sort(() => Math.random() - 0.5);
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
    this.showBanner('A merchant has come to town');
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
    const p = this.hero.root.position;
    switch (ware.id) {
      case 'weapon':
        this.equip(weapon);
        this.showBanner(`${weapon.title}: ${weapon.text.toLowerCase()}`);
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
        this.showBanner('A sellsword joins you for 2 waves');
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
          this.showBanner('A ranger joins you');
          return { title: 'Ranger II', blurb: 'Shoots 40% faster', wood: 0, gold: 35, minTier: 2 };
        }
        this.ranger.level++;
        this.showBanner(`Ranger ${this.ranger.level === 2 ? 'II' : 'III'}`);
        return this.ranger.level === 2 ? { title: 'Ranger III', blurb: 'Twin arrows, +1 damage', wood: 0, gold: 55, minTier: 3 } : null;
      },
    });
  }

  private updateAllies(dt: number): void {
    const ctx = {
      hero: this.hero.root.position,
      nearest: (from: THREE.Vector3, range: number) => this.nearestEnemy(from, range)?.actor.root.position ?? null,
      shoot: (from: THREE.Vector3, target: THREE.Vector3, damage: number, count: number) => {
        this.sfx.shoot(true);
        this.fire(from, target, damage, count, 0);
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
      const e = this.spawnEnemy(kind, site.x + Math.cos(a) * 4, site.z + Math.sin(a) * 4, this.nearestOpenSide(new THREE.Vector3(site.x, 0, site.z)), false);
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
      this.showBanner(`Camp razed: +${20 + w * 4} gold, +12 wood`);
      return;
    }
    const r = Math.random();
    if (r < 0.15) {
      const weapon = this.otherWeapon();
      this.equip(weapon);
      this.showBanner(`Found a ${weapon.title}: ${weapon.text.toLowerCase()}`);
    } else if (r < 0.35) {
      this.pendingCards++;
      this.showBanner('Found a boon');
    } else if (r < 0.65) {
      this.economy.grant(14 + w * 2, 0);
      this.showBanner(`Found ${14 + w * 2} wood`);
    } else {
      this.economy.grant(0, 12 + w * 3);
      this.showBanner(`Found ${12 + w * 3} gold`);
    }
  }

  /** Takes damage on the hero, softened by armour; ends the kill streak. */
  private hurtHero(amount: number): void {
    const dealt = amount * this.upgrades.armor;
    this.hp -= dealt;
    this.hurtBank += dealt;
    if (this.streak > 0) { this.streak = 0; this.refreshHud(); }
    if (this.relics.has('ward') && this.elapsed >= this.wardReady) {
      this.wardReady = this.elapsed + WARD_GAP;
      const p = this.hero.root.position;
      this.aura(p.x, p.z, WARD_RADIUS, 1, 0.4, true);
    }
  }

  /** Offers three relics not yet held, after a boss falls. */
  private showRelics(): void {
    this.pendingRelic = false;
    const open = RELICS.filter((r) => !this.relics.has(r.id)).sort(() => Math.random() - 0.5).slice(0, 3);
    if (open.length === 0) return;
    this.present(`The ${this.map.boss.name} has fallen: claim a relic`, open.map((r) => ({
      title: r.title, text: r.text,
      pick: () => { this.relics.add(r.id); r.apply?.(this.upgrades); this.showBanner(r.title); },
    })));
  }

  private setBoss(e: Enemy | null): void {
    this.boss = e;
    this.ui.boss.style.display = e ? 'block' : 'none';
    if (e) { this.bossMax = e.hp; this.ui.bossFill.style.width = '100%'; this.ui.bossName.textContent = this.map.boss.name; }
  }

  private gainXp(amount: number): void {
    this.xp += amount;
    while (this.xp >= xpForLevel(this.level)) {
      this.xp -= xpForLevel(this.level);
      this.level++;
      this.pendingCards++;
      const p = this.hero.root.position;
      this.sfx.levelUp();
      this.fx.ring(p.x, p.z, 0x9fd8ff, 8);
      this.fx.burst(p.x, 1.2, p.z, 0x9fd8ff, 22, 9, 0.2);
    }
    this.refreshHud();
  }

  private showCards(): void {
    const open = CARDS.filter((c) => (this.taken.get(c.id) ?? 0) < c.max);
    if (open.length === 0) { this.pendingCards = 0; return; }
    const pick = [...open].sort(() => Math.random() - 0.5).slice(0, 3);
    this.present('Choose a boon', pick.map((card) => ({
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
    this.ui.cards.replaceChildren();
    const row = document.createElement('div');
    row.className = 'row';
    choices.forEach((c, i) => {
      const b = document.createElement('button');
      const title = document.createElement('strong');
      title.textContent = c.title;
      const text = document.createElement('span');
      text.textContent = c.text;
      b.append(title, text);
      b.addEventListener('click', () => this.chooseCard(i));
      row.append(b);
    });
    const h = document.createElement('h2');
    h.textContent = heading;
    this.ui.cards.append(h, row);
    this.ui.cards.style.display = 'flex';
  }

  private hideCards(): void {
    this.offered = null;
    this.ui.cards.style.display = 'none';
  }

  chooseCard(index: number): void {
    const choice = this.offered?.[index];
    if (!choice) return;
    this.sfx.pick();
    this.hideCards();
    choice.pick();
    this.refreshHud();
  }

  private showBanner(text: string): void {
    this.ui.banner.textContent = text;
    this.ui.banner.style.opacity = '1';
    this.bannerTimer = 1.5;
  }

  private spawnOne(): boolean {
    const kind = this.toSpawn[this.toSpawn.length - 1];
    const side = this.map.openSides[Math.floor(Math.random() * this.map.openSides.length)];
    const [nx, nz] = GATE_SIDES[side];
    const dist = CAMP + 6 + Math.random() * 6;
    const lateral = (Math.random() - 0.5) * 6;
    const e = this.spawnEnemy(kind, nx * dist + nz * lateral, nz * dist + nx * lateral, side, false);
    if (!e) return false;
    this.toSpawn.pop();
    const eliteMul = this.current.mod.elites ?? 1;
    if (kind !== 'Boss' && kind !== 'Hexer' && this.wave >= (eliteMul > 1 ? 2 : ELITE_WAVE) && Math.random() < ELITE_CHANCE * eliteMul) {
      const traits = Object.keys(ELITES) as Elite[];
      const trait = traits[Math.floor(Math.random() * traits.length)];
      e.elite = trait;
      if (trait === 'armored') e.hp *= 3;
      e.actor.setGlow(ELITES[trait].glow);
    }
    return true;
  }

  private rangedOf(e: Enemy): (RangedAttack & { spread?: number }) | undefined {
    return e.kind === 'Boss' ? this.map.boss.ranged : ENEMIES[e.kind].ranged;
  }

  /** Puts a pooled enemy into play at a point, rising from the ground. */
  private spawnEnemy(kind: EnemyKind, x: number, z: number, side: number, inside: boolean): Enemy | null {
    const e = this.acquire(kind);
    if (!e) return null;
    e.side = side;
    e.actor.root.position.set(x, 0, z);
    e.actor.root.rotation.y = Math.atan2(-x, -z);
    e.inside = inside;
    e.stuckFor = 0;
    e.elite = null;
    e.wild = false;
    e.raider = !inside && Math.random() < RAIDER_CHANCE;
    e.target = null;
    e.retarget = 0;
    e.summonTimer = this.map.boss.summon?.interval ?? 0;
    const past = Math.max(0, this.wave - this.map.waves);
    e.hp = Math.round(enemyHp(e.kind, Math.max(1, this.wave), this.map) * (1 + past * ENDLESS_HP));
    e.animDt = 0;
    e.cooldown = this.rangedOf(e)?.interval ?? 0;
    e.slowUntil = 0;
    e.frozenUntil = 0;
    e.thorn = 0;
    if (e.kind === 'Boss') this.setBoss(e);
    e.alive = true;
    e.active = true;
    e.timer = 0.9;
    e.actor.reset();
    if (e.kind === 'Boss' && this.map.boss.glow) e.actor.setGlow(this.map.boss.glow);
    e.actor.play('Spawn_Ground', true, 0);
    this.fx.burst(e.actor.root.position.x, 0.3, e.actor.root.position.z, DUST, e.kind === 'Boss' ? 24 : 5, e.kind === 'Boss' ? 10 : 4, 0.22);
    this.scene.add(e.actor.root);
    return e;
  }

  /** Outside the walls, a straight path that would cut through the camp goes via the nearest corner instead. */
  private aroundCamp(p: THREE.Vector3, tx: number, tz: number): [number, number] {
    let blocked = false;
    for (let i = 1; i < 8 && !blocked; i++) {
      const k = i / 8;
      blocked = Math.max(Math.abs(p.x + (tx - p.x) * k), Math.abs(p.z + (tz - p.z) * k)) < CAMP + 1.5;
    }
    if (!blocked) return [tx, tz];
    const from = Math.atan2(p.z, p.x);
    const turn = Math.sign(Math.atan2(Math.sin(Math.atan2(tz, tx) - from), Math.cos(Math.atan2(tz, tx) - from))) || 1;
    let corner = 0;
    let best = Infinity;
    for (let c = 0; c < 4; c++) {
      const angle = Math.PI / 4 + (c * Math.PI) / 2;
      let ahead = (angle - from) * turn;
      ahead = ((ahead % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      if (ahead > 0.05 && ahead < best) { best = ahead; corner = angle; }
    }
    const r = CAMP + 3.5;
    return [Math.sign(Math.cos(corner)) * r, Math.sign(Math.sin(corner)) * r];
  }

  /** A walker wedged somewhere for too long reappears outside its gate, so a wave can always end. */
  private checkStuck(e: Enemy, dt: number): void {
    const p = e.actor.root.position;
    if (Math.hypot(p.x - e.anchorX, p.z - e.anchorZ) > 1.5) {
      e.anchorX = p.x;
      e.anchorZ = p.z;
      e.stuckFor = 0;
      return;
    }
    e.stuckFor += dt;
    if (e.stuckFor < STUCK_LIMIT) return;
    const [nx, nz] = GATE_SIDES[this.nearestOpenSide(p)];
    p.set(nx * (CAMP + 4), 0, nz * (CAMP + 4));
    e.inside = false;
    e.stuckFor = 0;
    this.fx.burst(p.x, 0.3, p.z, DUST, 6, 4, 0.22);
  }

  /** The open gate side facing a point. */
  private nearestOpenSide(p: THREE.Vector3): number {
    let best = this.map.openSides[0];
    let bestD = -Infinity;
    for (const side of this.map.openSides) {
      const [nx, nz] = GATE_SIDES[side];
      const d = p.x * nx + p.z * nz - Math.abs(p.x * nz + p.z * nx) * 0.5;
      if (d > bestD) { bestD = d; best = side; }
    }
    return best;
  }

  private pushOutOfObstacles(p: THREE.Vector3, radius: number): void {
    for (const o of this.obstacles) {
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const min = o.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = o.x + (dx / d) * min;
        p.z = o.z + (dz / d) * min;
      }
    }
  }

  private updateHero(dt: number, input: Input): void {
    const p = this.hero.root.position;
    const chopping = this.economy.update(dt, p);
    if (this.upgrades.regen > 0 && this.hp < this.upgrades.maxHp) {
      this.hp = Math.min(this.upgrades.maxHp, this.hp + this.upgrades.regen * dt);
      this.refreshHud();
    }
    const moving = input.x !== 0 || input.z !== 0;
    if (moving) {
      const prev = { x: p.x, z: p.z };
      p.x += input.x * this.upgrades.speed * dt;
      p.z += input.z * this.upgrades.speed * dt;
      p.x = THREE.MathUtils.clamp(p.x, -WORLD_LIMIT, WORLD_LIMIT);
      p.z = THREE.MathUtils.clamp(p.z, -WORLD_LIMIT, WORLD_LIMIT);
      // The hero's own barricades open for them, so every gate is passable.
      collideWalls(p, prev, 0.7, () => true);
      this.pushOutOfObstacles(p, 0.7);
      this.hero.play('Running_A');
      if (this.relics.has('embers')) {
        this.emberTimer -= dt;
        if (this.emberTimer <= 0) { this.emberTimer = EMBER_GAP; this.ignite(p.x, p.z, EMBER_RADIUS, 1.6); }
      }
    } else {
      this.hero.play(chopping ? 'Interact' : 'Idle_A');
    }

    const w = this.weapon;
    const reach = w.reach ? w.reach + (this.upgrades.arrows - 1) * 0.6 : 0;
    const target = this.nearestEnemy(p, reach || this.upgrades.range + w.range);
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
          const chain = this.relics.has('storm') && ++this.shots % STORM_EVERY === 0;
          this.fire(p.clone().setY(1.7), tp, roll(this.upgrades.damage * w.damage), this.upgrades.arrows, this.upgrades.pierce + w.pierce, chain);
        }
      }
    }
    if (face !== null) {
      const cur = this.hero.root.rotation.y;
      const diff = Math.atan2(Math.sin(face - cur), Math.cos(face - cur));
      this.hero.root.rotation.y = cur + diff * Math.min(1, dt * 14);
    }
    const flutter = moving ? 0.72 + Math.sin(this.elapsed * 15) * 0.09 : 0.14 + Math.sin(this.elapsed * 2.4) * 0.03;
    this.cape.rotation.x += (flutter - this.cape.rotation.x) * Math.min(1, dt * 9);
    this.hero.update(dt);
  }

  private nearestEnemy(p: THREE.Vector3, range: number): Enemy | null {
    let best: Enemy | null = null;
    let bestD = range * range;
    for (const e of this.pool) {
      if (!e.alive || e.timer > 0) continue;
      const q = e.actor.root.position;
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** The greataxe: one sweeping blow at every foe within reach. */
  private cleave(p: THREE.Vector3, reach: number, damage: number): void {
    const amount = roll(damage);
    for (const e of this.pool) {
      if (!e.alive || e.timer > 0) continue;
      const q = e.actor.root.position;
      const away = new THREE.Vector3(q.x - p.x, 0, q.z - p.z);
      if (away.length() > reach + ENEMIES[e.kind].hitRadius * 0.5) continue;
      this.damage(e, amount, away.normalize().multiplyScalar(4));
    }
    this.sfx.boulder();
    this.fx.ring(p.x, p.z, 0xffe0b0, reach);
    this.fx.burst(p.x, 1, p.z, 0xffe0b0, 10, 8, 0.16);
  }

  /** Lightning leaps from a struck foe to a few more nearby. */
  private arc(from: Enemy, damage: number): void {
    const p = from.actor.root.position;
    const near = this.pool
      .filter((e) => e !== from && e.alive && e.timer <= 0 && e.actor.root.position.distanceTo(p) < STORM_RANGE)
      .sort((a, b) => a.actor.root.position.distanceTo(p) - b.actor.root.position.distanceTo(p))
      .slice(0, STORM_TARGETS);
    for (const e of near) {
      const q = e.actor.root.position;
      for (let k = 1; k <= 4; k++) {
        const t = k / 5;
        this.fx.burst(p.x + (q.x - p.x) * t, 1.4, p.z + (q.z - p.z) * t, 0xa8e0ff, 2, 2, 0.14);
      }
      this.damage(e, damage, NO_PUSH);
    }
    if (near.length) this.sfx.beacon();
  }

  private fire(from: THREE.Vector3, target: THREE.Vector3, damage: number, count: number, pierce: number, chain = false): void {
    const aim = target.clone().setY(1.5).sub(from).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < count; i++) {
      const dir = aim.clone().applyAxisAngle(up, (i - (count - 1) / 2) * CARD_SPREAD);
      const obj = this.arrowModel.clone();
      obj.position.copy(from);
      obj.lookAt(from.clone().add(dir));
      this.scene.add(obj);
      const trail = obj.getObjectByName('trail')!;
      trail.scale.z = 0.01;
      this.arrows.push({ obj, trail, travelled: 0, dir, life: 0.9, damage, pierce, hit: new Set(), chain });
    }
  }

  private lob(from: THREE.Vector3, target: THREE.Vector3, radius: number, burn: boolean): void {
    const mesh = new THREE.Mesh(boulderGeometry, boulderMaterial);
    mesh.castShadow = true;
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.sfx.shoot(true);
    this.boulders.push({ mesh, from: from.clone(), to: target.clone().setY(0.4), t: 0, damage: TOWERS.catapult.damage + this.upgrades.towerDamage, radius, burn });
  }

  private updateBoulders(dt: number): void {
    for (let i = this.boulders.length - 1; i >= 0; i--) {
      const b = this.boulders[i];
      b.t = Math.min(1, b.t + dt / BOULDER_FLIGHT);
      b.mesh.position.lerpVectors(b.from, b.to, b.t);
      b.mesh.position.y += Math.sin(b.t * Math.PI) * BOULDER_ARC;
      b.mesh.rotation.x += dt * 7;
      b.mesh.rotation.z += dt * 5;
      if (b.t < 1) continue;
      this.scene.remove(b.mesh);
      this.boulders.splice(i, 1);
      const { x, z } = b.to;
      this.sfx.boulder();
      this.fx.burst(x, 0.5, z, DUST, 16, 9, 0.28);
      this.fx.ring(x, z, 0xffd9a0, b.radius);
      if (b.burn) this.ignite(x, z);
      this.fx.shake(0.14);
      for (const e of this.pool) {
        if (!e.alive || e.timer > 0) continue;
        const p = e.actor.root.position;
        const away = new THREE.Vector3(p.x - x, 0, p.z - z);
        if (away.length() > b.radius + ENEMIES[e.kind].hitRadius * 0.4) continue;
        this.damage(e, b.damage, away.normalize().multiplyScalar(3));
      }
    }
  }

  private ignite(x: number, z: number, r = BURN_RADIUS, life = BURN_TIME): void {
    const mesh = new THREE.Mesh(fireGeometry, fireMaterial);
    mesh.position.set(x, 0.1, z);
    this.scene.add(mesh);
    this.fires.push({ mesh, x, z, r, life, tick: 0 });
  }

  private updateFires(dt: number): void {
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.life -= dt;
      f.tick -= dt;
      f.mesh.scale.setScalar((0.85 + Math.sin(f.life * 18) * 0.06) * (f.r / BURN_RADIUS));
      if (f.tick <= 0) {
        f.tick = BURN_TICK;
        this.fx.burst(f.x + (Math.random() - 0.5) * f.r, 0.4, f.z + (Math.random() - 0.5) * f.r, 0xff8a30, 3, 4, 0.16);
        for (const e of this.pool) {
          if (!e.alive || e.timer > 0) continue;
          const p = e.actor.root.position;
          if ((p.x - f.x) ** 2 + (p.z - f.z) ** 2 < f.r * f.r) this.damage(e, 1, NO_PUSH, true);
        }
      }
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        this.fires.splice(i, 1);
      }
    }
  }

  private aura(x: number, z: number, radius: number, damage: number, slow: number, freeze: boolean): void {
    let touched = false;
    for (const e of this.pool) {
      if (!e.alive || e.timer > 0) continue;
      const p = e.actor.root.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 > radius * radius) continue;
      touched = true;
      e.slowUntil = this.elapsed + SLOW_TIME;
      e.slowFactor = slow;
      if (freeze) {
        e.frozenUntil = this.elapsed + FREEZE_TIME;
        this.fx.burst(p.x, 1.4, p.z, 0xe8f8ff, 6, 4, 0.2);
      }
      this.fx.burst(p.x, 1.2, p.z, 0x9fe0ff, 2, 3, 0.12);
      this.damage(e, damage, NO_PUSH, true);
    }
    if (touched) {
      this.fx.ring(x, z, freeze ? 0xffffff : 0x9fe0ff, radius);
      this.sfx.beacon();
    }
  }

  private castOrb(from: THREE.Vector3, damage: number, spread = 1): void {
    const hero = this.hero.root.position;
    const aim = new THREE.Vector3(hero.x - from.x, 0, hero.z - from.z).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < spread; i++) {
      const dir = aim.clone().applyAxisAngle(up, (i - (spread - 1) / 2) * 0.28);
      const mesh = new THREE.Mesh(orbGeometry, orbMaterial);
      mesh.position.set(from.x, 1.5, from.z).addScaledVector(dir, 0.8);
      this.scene.add(mesh);
      this.orbs.push({ mesh, dir, life: ORB_LIFE, damage });
    }
    this.sfx.cast();
  }

  /** Spikes on the road: a point of damage and a slow for everything in the circle. */
  private trapPulse(x: number, z: number, radius: number): void {
    for (const e of this.pool) {
      if (!e.alive || e.timer > 0) continue;
      const p = e.actor.root.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 > radius * radius) continue;
      const slowed = e.slowUntil > this.elapsed ? e.slowFactor : 1;
      e.slowFactor = Math.min(slowed, TRAP_SLOW);
      e.slowUntil = Math.max(e.slowUntil, this.elapsed + TRAP_SLOW);
      this.fx.burst(p.x, 0.4, p.z, 0xb08a5a, 2, 3, 0.12);
      this.damage(e, 1, NO_PUSH, true);
    }
  }

  /** 0 fires a ring of bolts; 1 bashes nearby foes away and stuns them. */
  useAbility(index: number): void {
    if (!this.running || this.paused || this.offered || this.abilityCooldown[index] > 0) return;
    const p = this.hero.root.position;
    if (index === 0) {
      this.abilityCooldown[0] = VOLLEY_COOLDOWN;
      const from = p.clone().setY(1.6);
      for (let i = 0; i < VOLLEY_BOLTS; i++) {
        const a = (i / VOLLEY_BOLTS) * Math.PI * 2;
        this.fire(from, new THREE.Vector3(p.x + Math.cos(a) * 10, 1.5, p.z + Math.sin(a) * 10), this.upgrades.damage + 1, 1, 1);
      }
      this.sfx.shoot();
      this.fx.ring(p.x, p.z, GOLD, 5);
      this.fx.shake(0.15);
    } else {
      this.abilityCooldown[1] = BASH_COOLDOWN;
      for (const e of this.pool) {
        if (!e.alive || e.timer > 0) continue;
        const q = e.actor.root.position;
        const away = new THREE.Vector3(q.x - p.x, 0, q.z - p.z);
        const d = away.length();
        if (d > BASH_RADIUS) continue;
        away.normalize();
        if (e.kind !== 'Boss') {
          q.addScaledVector(away, BASH_PUSH * (1 - d / (BASH_RADIUS + 1)));
          e.frozenUntil = Math.max(e.frozenUntil, this.elapsed + BASH_STUN);
        }
        this.damage(e, BASH_DAMAGE, NO_PUSH);
      }
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
      const shown = Math.round((this.abilityCooldown[i] / full) * 100) / 100;
      if (shown === this.shownCooldown[i]) continue;
      this.shownCooldown[i] = shown;
      const button = this.ui.abilities[i];
      button.style.setProperty('--cd', String(shown));
      button.classList.toggle('ready', shown === 0);
    }
  }

  /** Arrows at the screen edge point to foes out of view, with how many lie that way. */
  private updateEdgeArrows(): void {
    const sectors = new Map<number, { count: number; boss: boolean }>();
    if (this.running) {
      for (const e of this.pool) {
        if (!e.alive || e.timer > 0) continue;
        const v = this.projected.copy(e.actor.root.position).setY(1).project(this.camera);
        const behind = v.z > 1;
        if (!behind && Math.abs(v.x) < 0.98 && Math.abs(v.y) < 0.98) continue;
        const angle = behind ? Math.atan2(-v.y, -v.x) : Math.atan2(v.y, v.x);
        const sector = ((Math.round((angle / (Math.PI * 2)) * ARROW_SECTORS) % ARROW_SECTORS) + ARROW_SECTORS) % ARROW_SECTORS;
        const s = sectors.get(sector) ?? { count: 0, boss: false };
        s.count++;
        s.boss ||= e.kind === 'Boss';
        sectors.set(sector, s);
      }
    }
    const w = innerWidth, h = innerHeight;
    let i = 0;
    for (const [sector, s] of sectors) {
      if (i >= this.edgeArrows.length) break;
      const a = this.edgeArrows[i++];
      const angle = (sector / ARROW_SECTORS) * Math.PI * 2;
      const cx = Math.cos(angle), cy = Math.sin(angle);
      const k = 1 / Math.max(Math.abs(cx), Math.abs(cy));
      const x = THREE.MathUtils.clamp((cx * k * 0.5 + 0.5) * w, ARROW_MARGIN, w - ARROW_MARGIN);
      const y = THREE.MathUtils.clamp((-cy * k * 0.5 + 0.5) * h, ARROW_MARGIN + 40, h - ARROW_MARGIN);
      a.root.style.display = 'block';
      a.root.style.transform = `translate(${x}px,${y}px)`;
      a.root.classList.toggle('boss', s.boss);
      a.arrow.style.transform = `rotate(${-angle}rad)`;
      a.count.textContent = s.count > 1 ? String(s.count) : '';
    }
    for (; i < this.edgeArrows.length; i++) this.edgeArrows[i].root.style.display = 'none';

    // Off-screen camps and chests get their own markers.
    let j = 0;
    if (this.running) {
      for (const s of this.wilds.all) {
        if (j >= this.siteArrows.length) break;
        const v = this.projected.set(s.x, 1, s.z).project(this.camera);
        const behind = v.z > 1;
        if (!behind && Math.abs(v.x) < 0.98 && Math.abs(v.y) < 0.98) continue;
        const angle = behind ? Math.atan2(-v.y, -v.x) : Math.atan2(v.y, v.x);
        const cx = Math.cos(angle), cy = Math.sin(angle);
        const k = 1 / Math.max(Math.abs(cx), Math.abs(cy));
        const x = THREE.MathUtils.clamp((cx * k * 0.5 + 0.5) * w, ARROW_MARGIN, w - ARROW_MARGIN);
        const y = THREE.MathUtils.clamp((-cy * k * 0.5 + 0.5) * h, ARROW_MARGIN + 40, h - ARROW_MARGIN);
        const a = this.siteArrows[j++];
        a.root.style.display = 'block';
        a.root.style.transform = `translate(${x}px,${y}px)`;
        a.root.classList.toggle('camp', s.kind === 'camp');
        a.arrow.style.transform = `rotate(${-angle}rad)`;
      }
    }
    for (; j < this.siteArrows.length; j++) this.siteArrows[j].root.style.display = 'none';
  }

  private updateOrbs(dt: number): void {
    const hero = this.hero.root.position;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.mesh.position.addScaledVector(o.dir, ORB_SPEED * dt);
      o.life -= dt;
      const hit = (o.mesh.position.x - hero.x) ** 2 + (o.mesh.position.z - hero.z) ** 2 < 1.1;
      if (hit) {
        this.hurtHero(o.damage);
        this.showHurt();
        this.fx.burst(hero.x, 1.5, hero.z, 0xc070ff, 12, 7, 0.16);
        this.refreshHud();
      }
      if (hit || o.life <= 0) {
        this.scene.remove(o.mesh);
        this.orbs.splice(i, 1);
      }
      if (this.hp <= 0 && !this.over) { this.endRun(false); return; }
    }
  }

  private updateArrows(dt: number): void {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.obj.position.addScaledVector(a.dir, ARROW_SPEED * dt);
      a.travelled += ARROW_SPEED * dt;
      a.trail.scale.z = Math.max(0.01, Math.min(1, a.travelled / TRAIL_LENGTH));
      a.life -= dt;
      let spent = false;
      for (const e of this.pool) {
        if (!e.alive || e.timer > 0 || a.hit.has(e)) continue;
        const p = e.actor.root.position;
        const dx = p.x - a.obj.position.x;
        const dz = p.z - a.obj.position.z;
        const r = ENEMIES[e.kind].hitRadius;
        if (dx * dx + dz * dz < r * r) {
          this.damage(e, a.damage, a.dir);
          a.hit.add(e);
          if (a.chain) { a.chain = false; this.arc(e, Math.max(2, a.damage)); }
          if (a.pierce-- <= 0) { spent = true; break; }
        }
      }
      if (spent || a.life <= 0) {
        this.scene.remove(a.obj);
        this.arrows.splice(i, 1);
      }
    }
  }

  private damage(e: Enemy, amount: number, dir: THREE.Vector3, quiet = false): void {
    e.hp -= amount;
    e.actor.flash();
    e.actor.punch();
    const hit = e.actor.root.position;
    const height = ENEMIES[e.kind].scale * 1.9;
    if (e.kind !== 'Boss') { hit.x += dir.x * KNOCKBACK; hit.z += dir.z * KNOCKBACK; }
    if (!quiet) {
      this.fx.number(hit.x, height, hit.z, `${amount}`, e.kind === 'Boss' ? '#ffd24a' : '#fff3d6', e.kind === 'Boss' ? 1.35 : 1);
      this.fx.burst(hit.x, height * 0.55, hit.z, BONE, 3, 5, 0.13);
      this.sfx.hit();
    }
    if (e === this.boss) this.ui.bossFill.style.width = `${Math.max(0, e.hp / this.bossMax) * 100}%`;
    if (e.hp <= 0) {
      e.alive = false;
      e.timer = 1.8;
      e.actor.play('Death_A', true, 0.08);
      this.kills++;
      const p = e.actor.root.position;
      this.sfx.kill();
      this.fx.burst(p.x, height * 0.5, p.z, BONE, e.kind === 'Minion' ? 9 : 16, 8, 0.2);
      if (e.kind === 'Warrior') this.fx.shake(0.12);
      if (e.kind === 'Boss') {
        this.sfx.bossDown();
        this.fx.burst(p.x, 2.5, p.z, 0xb03ad0, 70, 15, 0.34);
        this.fx.ring(p.x, p.z, 0xd070ff, 16);
        this.fx.shake(1);
        this.slowmo = BOSS_DEATH_SLOWMO;
      }
      const reward = (e.elite ? 3 : 1) * this.streakMul * this.upgrades.goldMul * (this.current.mod.gold ?? 1);
      this.economy.dropGold(p.x, p.z, roll(ENEMIES[e.kind].gold * reward));
      this.streak++;
      if (this.relics.has('vampire') && this.hp < this.upgrades.maxHp) this.hp = Math.min(this.upgrades.maxHp, this.hp + 1);
      this.gainXp(ENEMIES[e.kind].xp * (e.elite ? 2 : 1));
      if (e.elite) this.fx.ring(p.x, p.z, ELITES[e.elite].glow, 3);
      if (e.elite === 'splitting') {
        for (const s of [-1, 1]) this.spawnEnemy('Minion', p.x + s * 1.2, p.z, e.side, e.inside);
      }
      if (e === this.boss) this.setBoss(null);
    }
  }

  private updateEnemies(dt: number): void {
    const hero = this.hero.root.position;
    this.heroInside = besideWall(hero, this.heroInside);
    const heroInside = this.heroInside;
    let touching = 0;
    const crowded = this.pool.filter((e) => e.active).length > 40;
    let index = -1;
    for (const e of this.pool) {
      index++;
      if (!e.active) continue;
      // With a big horde, each skeleton re-poses every other frame.
      const frozen = e.alive && e.frozenUntil > this.elapsed;
      if (!frozen) e.animDt += dt;
      if (!crowded || (index + this.frame) % 2 === 0) { e.actor.update(e.animDt); e.animDt = 0; }
      const p = e.actor.root.position;

      if (!e.alive) {
        e.timer -= dt;
        if (e.timer < 0.5) p.y -= dt * 2.4; // sink into the ground
        if (e.timer <= 0) { p.y = 0; this.release(e); }
        continue;
      }
      if (e.timer > 0) { e.timer -= dt; continue; }
      const prev = { x: p.x, z: p.z };

      // Raiders go for cottages and the mine unless the hero is close.
      e.inside = besideWall(p, e.inside);
      e.retarget -= dt;
      if (e.retarget <= 0) {
        e.retarget = 0.8 + Math.random() * 0.4;
        e.target = this.pickTarget(e, hero);
      }
      if (e.target && !this.economy.standing(e.target)) e.target = null;
      const goal = e.target ?? hero;
      // When the wall stands between a skeleton and its goal, it heads through the nearest gate.
      const crossing = e.inside !== (e.target ? insideCamp(e.target) : heroInside);
      let tx = goal.x, tz = goal.z;
      if (crossing) {
        // Line up in front of the gate first, then walk through it.
        e.side = this.nearestOpenSide(p);
        const [nx, nz] = GATE_SIDES[e.side];
        const near = e.inside ? CAMP - 3 : CAMP + 3;
        const lined = Math.abs(p.x * nz + p.z * nx) < GATE_LANE && Math.abs(p.x * nx + p.z * nz - CAMP) < 4;
        const d = lined ? 2 * CAMP - near : near;
        tx = nx * d;
        tz = nz * d;
      }
      if (!e.inside && !insideCamp({ x: tx, z: tz })) [tx, tz] = this.aroundCamp(p, tx, tz);
      const chasing = !e.target && tx === hero.x && tz === hero.z;
      const dx = tx - p.x;
      const dz = tz - p.z;
      const dist = Math.hypot(dx, dz);
      const sieging = !!e.target && !crossing && dist < e.target.r + 1.4;
      const [gx, gz] = GATE_SIDES[e.side];
      const blocked = crossing && this.economy.hasGate(e.side) && Math.hypot(p.x - gx * CAMP, p.z - gz * CAMP) < 3.4;
      const stats = ENEMIES[e.kind];
      const ranged = this.rangedOf(e);
      const inCastRange = !!ranged && chasing && dist <= ranged.range;
      if (e.kind === 'Boss' && this.map.boss.summon && !frozen) {
        e.summonTimer -= dt;
        if (e.summonTimer <= 0) {
          const { interval, count } = this.map.boss.summon;
          e.summonTimer = interval;
          for (let s = 0; s < count; s++) {
            const a = (s / count) * Math.PI * 2;
            this.spawnEnemy('Minion', p.x + Math.cos(a) * 2.5, p.z + Math.sin(a) * 2.5, e.side, e.inside);
          }
          this.fx.ring(p.x, p.z, 0xff6a20, 4);
          this.sfx.cast();
        }
      }
      if (inCastRange && !frozen) {
        e.cooldown -= dt;
        if (e.cooldown <= 0) {
          e.cooldown = ranged!.interval;
          e.actor.play('Throw', true, 0.05);
          this.castOrb(p, ranged!.damage, ranged!.spread ?? 1);
        } else if (e.cooldown < ranged!.interval - CAST_TIME) {
          e.actor.play('Idle_A');
        }
      } else {
        e.actor.play(blocked || sieging ? 'Interact' : stats.walk);
      }

      if (frozen || inCastRange) {
        // Frozen foes are held fast; hexers hold their ground and keep casting.
      } else if (sieging) {
        this.economy.hitStructure(e.target!, stats.dps * dt);
      } else if (blocked) {
        if (this.economy.hitGate(e.side, ENEMIES[e.kind].dps * dt)) {
          e.thorn += THORN_DPS * dt;
          if (e.thorn >= 1) {
            const owed = Math.floor(e.thorn);
            e.thorn -= owed;
            this.damage(e, owed, NO_PUSH, true);
            if (!e.alive) continue;
          }
        }
      } else if (chasing && dist < 1.3) {
        touching += ENEMIES[e.kind].dps;
      } else if (dist > 1e-3) {
        prev.x = p.x;
        prev.z = p.z;
        const step = stats.speed * (e.elite === 'swift' ? 1.6 : 1) * (this.current.mod.speed ?? 1) * dt * (e.slowUntil > this.elapsed ? e.slowFactor : 1);
        p.x += (dx / dist) * step;
        p.z += (dz / dist) * step;
        this.checkStuck(e, dt);
      }
      if (dist > 1e-3) e.actor.root.rotation.y = Math.atan2(dx, dz);

      // Keep the horde from stacking into one point.
      for (const o of this.pool) {
        if (o === e || !o.alive || o.timer > 0) continue;
        const q = o.actor.root.position;
        const sx = p.x - q.x;
        const sz = p.z - q.z;
        const s2 = sx * sx + sz * sz;
        if (s2 < 1.44 && s2 > 1e-6) {
          const s = Math.sqrt(s2);
          const push = (1.2 - s) * 0.5;
          p.x += (sx / s) * push;
          p.z += (sz / s) * push;
        }
      }
      this.pushOutOfObstacles(p, 0.55);
      collideWalls(p, prev, 0.55, (side) => !this.economy.hasGate(side));
    }
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

  /** A cottage for foes inside the walls, the mine for raiders outside, or null to chase the hero. */
  private pickTarget(e: Enemy, hero: THREE.Vector3): Structure | null {
    const p = e.actor.root.position;
    if (e.wild || e.kind === 'Boss' || Math.hypot(hero.x - p.x, hero.z - p.z) < 6) return null;
    if (!e.inside && !e.raider) return null;
    let best: Structure | null = null;
    let bestD = e.inside ? 18 : 26;
    for (const s of this.economy.targets(e.inside)) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** Damage arrives every frame, so it is shown in small bundles. */
  private showHurt(): void {
    this.hurtTimer = HURT_GAP;
    const p = this.hero.root.position;
    this.hero.flash();
    this.sfx.hurt();
    this.fx.shake(0.22);
    this.fx.number(p.x, 3.2, p.z, `-${Math.ceil(this.hurtBank)}`, '#ff6a50', 1.2);
    this.hurtBank = 0;
    this.hurtFlash = 1;
  }

  private updateHurtOverlay(dt: number): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3.5);
    const low = !this.over && this.hp / this.upgrades.maxHp < LOW_HP ? 0.3 + Math.sin(this.elapsed * 7) * 0.12 : 0;
    this.ui.hurt.style.opacity = `${Math.max(this.hurtFlash * 0.75, low)}`;
  }

  private endRun(won: boolean): void {
    this.over = true;
    this.showNext(false);
    if (won) this.sfx.win(); else this.sfx.lose();
    if (!won) this.fx.shake(0.8);
    this.pendingCards = 0;
    this.hideCards();
    this.setBoss(null);
    this.hero.play(won ? 'Idle_A' : 'Death_A', !won, 0.08);
    this.tutorial?.finish();
    this.tutorial = null;
    const minutes = Math.floor(this.elapsed / 60);
    const seconds = String(Math.floor(this.elapsed % 60)).padStart(2, '0');
    this.ui.over.style.display = 'flex';
    this.ui.endless.style.display = won && !this.endless ? '' : 'none';
    if (this.endless) {
      const held = Math.max(0, this.wave - 1 - this.map.waves);
      const banked = save.recordEndless(this.map, this.wave - 1, held * ENDLESS_PAY);
      this.ui.title.textContent = 'The last stand ends';
      this.ui.score.textContent = `You held ${held} endless ${held === 1 ? 'wave' : 'waves'}, to wave ${this.wave}, and slew ${this.kills} foes. ${banked} gold added to the treasury.`;
      return;
    }
    const banked = save.recordRun(this.map, won, this.wave, this.economy.gold);
    this.ui.title.textContent = won ? 'The hamlet stands' : 'The hamlet has fallen';
    this.ui.score.textContent = won
      ? `All ${this.map.waves} waves repelled. ${this.kills} foes slain in ${minutes}:${seconds}, at level ${this.level}.`
      : `You held until wave ${this.wave} and slew ${this.kills} foes, at level ${this.level}.`;
    this.ui.score.textContent += ` ${banked} gold added to the treasury.`;
    if (won) this.ui.score.textContent += ' Press on for endless waves?';
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
        const e = this.spawnEnemy(band.kind, band.x, band.z, this.nearestOpenSide(new THREE.Vector3(band.x, 0, band.z)), false);
        if (e) { this.campQueue.pop(); spawned = true; }
      }
      if (spawned) this.spawnTimer = Math.max(0.12, 0.55 - this.wave * 0.03);
      return;
    }
    if (this.pool.some((e) => e.alive && !e.wild)) return;
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
    this.ui.over.style.display = 'none';
    this.ui.endless.style.display = 'none';
    this.hero.play('Idle_A');
    this.restTimer = WAVE_REST;
    if (!this.merchant) this.merchantArrives();
    this.refreshHud();
  }

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
    this.camFocus.lerp(this.hero.root.position, Math.min(1, dt * 6));
    this.camera.position.set(this.camFocus.x, dist * 0.68, this.camFocus.z + dist * 0.74);
    this.camera.lookAt(this.camFocus.x, 0.8, this.camFocus.z - 0.5);
    this.fx.applyShake(this.camera);
    this.walls.update(this.camFocus, dt);
    this.sun.position.set(this.camFocus.x - 34, 44, this.camFocus.z + 20);
    this.sun.target.position.copy(this.camFocus);
  }

  update(dt: number, input: Input): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.ui.banner.style.opacity = '0';
    }
    this.updateWeather(dt, this.camFocus);
    if (!this.started) {
      this.updateMenuCamera(dt);
      return;
    }
    if (this.paused) return;
    this.frame++;
    this.fx.update(dt);
    if (this.frame % 2 === 0) this.updateEdgeArrows();
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
      this.tutorial.update(dt, this.hero.root.position, this.economy, this.kills);
      if (this.tutorial.done) this.tutorial = null;
    }
    const simDt = this.slowmo > 0 ? dt * SLOWMO_RATE : dt;
    this.slowmo = Math.max(0, this.slowmo - dt);
    if (!this.over) this.elapsed += simDt;
    if (this.over) {
      this.hero.update(dt);
      for (const e of this.pool) if (e.active) e.actor.update(dt);
    } else {
      this.updateHero(simDt, input);
      this.updateAllies(simDt);
      this.wilds.update(simDt, this.hero.root.position, this.elapsed, this.wave);
      this.updateAbilities(simDt);
      this.updateArrows(simDt);
      this.updateBoulders(simDt);
      this.updateFires(simDt);
      this.updateOrbs(simDt);
      if (this.over) return;
      this.updateEnemies(simDt);
      this.updateWaves(simDt);
    }
    this.updateCamera(dt);
  }

  get debug() {
    return {
      weapon: this.weapon.id, relics: [...this.relics].join(), ranger: this.ranger?.level ?? 0, sellsword: !!this.sellsword, merchant: !!this.merchant,
      camps: this.wilds.camps.length, sites: this.wilds.all.length, streak: this.streak, endless: this.endless, mod: this.current.mod.id,
      hp: this.hp, wave: this.wave, kills: this.kills, active: this.pool.filter((e) => e.active).length, over: this.over, level: this.level, cards: this.offered?.length ?? 0, ...this.economy.stats };
  }
}
