import * as THREE from 'three';
import { Actor } from './actor';
import type { Assets } from './assets';
import { ENEMIES, type EnemyKind, type RangedAttack } from './data';
import type { Economy, Structure } from './economy';
import type { Fx } from './fx';
import type { MapDef } from './maps';
import { rand } from './rng';
import type { Sfx } from './sfx';
import { CAMP, GATE_SIDES, collideWalls, insideCamp, pushOutOfObstacles, type Obstacle } from './world';

const KNOCKBACK = 0.14;
const STUCK_LIMIT = 6;
/** Half-width of the lane through a gate that walkers line up in. */
const GATE_LANE = 2.2;
const CAST_TIME = 0.6;
const THORN_DPS = 3;
const SLOW_TIME = 1;
const FREEZE_TIME = 1.2;
const TRAP_SLOW = 0.6;
const RAIDER_CHANCE = 0.3;
const CORPSE_TIME = 1.8;
const BONE = 0xe9e1c9;
const DUST = 0xb9a584;
const NO_PUSH = new THREE.Vector3();

export type Elite = 'swift' | 'armored' | 'splitting';
export const ELITES: Record<Elite, { glow: number; label: string }> = {
  swift: { glow: 0x30c8ff, label: 'Swift' },
  armored: { glow: 0xffb020, label: 'Armored' },
  splitting: { glow: 0x60ff70, label: 'Splitting' },
};

/** Inside or outside the camp, changing only once clearly past the wall line, so standing in a gateway doesn't flicker. */
export const besideWall = (p: { x: number; z: number }, wasInside: boolean): boolean => {
  const d = Math.max(Math.abs(p.x), Math.abs(p.z));
  return wasInside ? d < CAMP + 1 : d < CAMP - 1;
};

export interface Enemy {
  actor: Actor;
  kind: EnemyKind;
  alive: boolean;
  active: boolean;
  hp: number;
  maxHp: number;
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

/** A foe that is in play and can be hit. */
export const ready = (e: Enemy): boolean => e.alive && e.timer <= 0;

export interface HordeHooks {
  hero(): THREE.Vector3;
  heroInside(): boolean;
  /** Speed multiplier from the current wave's twist. */
  speedMul(): number;
  /** Health for a foe of this kind spawned now: the wave, the map and endless scaling. */
  hpFor(kind: EnemyKind): number;
  castOrb(from: THREE.Vector3, damage: number, spread: number): void;
  killed(e: Enemy): void;
  bossSpawned(e: Enemy): void;
  bossHealth(fraction: number): void;
  bossFell(e: Enemy): void;
}

/** The skeleton pool: spawning, pathing through the gates, sieges, melee and casting, and dying. */
export class Horde {
  readonly pool: Enemy[] = [];
  boss: Enemy | null = null;
  bossMax = 1;
  /** Simulated seconds, used for slow and freeze timers. */
  time = 0;
  private frame = 0;

  constructor(
    private scene: THREE.Scene, private assets: Assets, private fx: Fx, private sfx: Sfx, private map: MapDef,
    private obstacles: Obstacle[], private economy: Economy, private hooks: HordeHooks,
  ) {}

  reset(): void {
    for (const e of this.pool) this.release(e);
    this.boss = null;
    this.time = 0;
  }

  get activeCount(): number {
    let n = 0;
    for (const e of this.pool) if (e.active) n++;
    return n;
  }

  /** Whether any foe that holds up the wave is still standing. */
  get waveAlive(): boolean { return this.pool.some((e) => e.alive && !e.wild); }

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
      e = {
        actor: new Actor(this.assets, model, stats.scale, true), kind, elite: null, summonTimer: 0, wild: false, raider: false, target: null, retarget: 0,
        alive: false, active: false, hp: 0, maxHp: 1, timer: 0, side: 0, inside: false, anchorX: 0, anchorZ: 0, stuckFor: 0, animDt: 0, cooldown: 0,
        slowUntil: 0, slowFactor: 1, frozenUntil: 0, thorn: 0,
      };
      this.pool.push(e);
    }
    return e;
  }

  /** Puts a pooled foe into play at a point, rising from the ground. */
  spawn(kind: EnemyKind, x: number, z: number, side: number, inside: boolean): Enemy | null {
    const e = this.acquire(kind);
    if (!e) return null;
    e.side = side;
    e.actor.root.position.set(x, 0, z);
    e.actor.root.rotation.y = Math.atan2(-x, -z);
    e.inside = inside;
    e.stuckFor = 0;
    e.elite = null;
    e.wild = false;
    e.raider = !inside && rand() < RAIDER_CHANCE;
    e.target = null;
    e.retarget = 0;
    e.summonTimer = this.map.boss.summon?.interval ?? 0;
    e.hp = e.maxHp = this.hooks.hpFor(kind);
    e.animDt = 0;
    e.cooldown = this.rangedOf(e)?.interval ?? 0;
    e.slowUntil = 0;
    e.frozenUntil = 0;
    e.thorn = 0;
    e.alive = true;
    e.active = true;
    e.timer = 0.9;
    e.actor.reset();
    if (kind === 'Boss') {
      this.boss = e;
      this.bossMax = e.hp;
      if (this.map.boss.glow) e.actor.setGlow(this.map.boss.glow);
      this.hooks.bossSpawned(e);
    }
    e.actor.play('Spawn_Ground', true, 0);
    this.fx.burst(x, 0.3, z, DUST, kind === 'Boss' ? 24 : 5, kind === 'Boss' ? 10 : 4, 0.22);
    this.scene.add(e.actor.root);
    return e;
  }

  makeElite(e: Enemy, trait: Elite): void {
    e.elite = trait;
    if (trait === 'armored') e.hp = e.maxHp = e.hp * 3;
    e.actor.setGlow(ELITES[trait].glow);
  }

  rangedOf(e: Enemy): (RangedAttack & { spread?: number }) | undefined {
    return e.kind === 'Boss' ? this.map.boss.ranged : ENEMIES[e.kind].ranged;
  }

  nearest(p: THREE.Vector3, range: number): Enemy | null {
    let best: Enemy | null = null;
    let bestD = range * range;
    for (const e of this.pool) {
      if (!ready(e)) continue;
      const q = e.actor.root.position;
      const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** The open gate side facing a point. */
  nearestOpenSide(p: { x: number; z: number }): number {
    let best = this.map.openSides[0];
    let bestD = -Infinity;
    for (const side of this.map.openSides) {
      const [nx, nz] = GATE_SIDES[side];
      const d = p.x * nx + p.z * nz - Math.abs(p.x * nz + p.z * nx) * 0.5;
      if (d > bestD) { bestD = d; best = side; }
    }
    return best;
  }

  damage(e: Enemy, amount: number, dir: THREE.Vector3, quiet = false): void {
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
    if (e === this.boss) this.hooks.bossHealth(Math.max(0, e.hp / this.bossMax));
    if (e.hp > 0) return;
    e.alive = false;
    e.timer = CORPSE_TIME;
    e.actor.play('Death_A', true, 0.08);
    const p = e.actor.root.position;
    this.sfx.kill();
    this.fx.burst(p.x, height * 0.5, p.z, BONE, e.kind === 'Minion' ? 9 : 16, 8, 0.2);
    if (e.kind === 'Warrior') this.fx.shake(0.12);
    if (e.kind === 'Boss') {
      this.sfx.bossDown();
      this.fx.burst(p.x, 2.5, p.z, 0xb03ad0, 70, 15, 0.34);
      this.fx.ring(p.x, p.z, 0xd070ff, 16);
      this.fx.shake(1);
    }
    if (e.elite) this.fx.ring(p.x, p.z, ELITES[e.elite].glow, 3);
    if (e.elite === 'splitting') {
      for (const s of [-1, 1]) this.spawn('Minion', p.x + s * 1.2, p.z, e.side, e.inside);
    }
    if (e === this.boss) { this.boss = null; this.hooks.bossFell(e); }
    this.hooks.killed(e);
  }

  /** Damages and slows every foe in a circle; `freeze` also holds them still for a moment. Returns whether anything was touched. */
  aura(x: number, z: number, radius: number, damage: number, slow: number, freeze: boolean): boolean {
    let touched = false;
    for (const e of this.pool) {
      if (!ready(e)) continue;
      const p = e.actor.root.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 > radius * radius) continue;
      touched = true;
      e.slowUntil = this.time + SLOW_TIME;
      e.slowFactor = slow;
      if (freeze) {
        e.frozenUntil = this.time + FREEZE_TIME;
        this.fx.burst(p.x, 1.4, p.z, 0xe8f8ff, 6, 4, 0.2);
      }
      this.fx.burst(p.x, 1.2, p.z, 0x9fe0ff, 2, 3, 0.12);
      this.damage(e, damage, NO_PUSH, true);
    }
    if (touched) {
      this.fx.ring(x, z, freeze ? 0xffffff : 0x9fe0ff, radius);
      this.sfx.beacon();
    }
    return touched;
  }

  /** Spikes on the road: a point of damage and a slow for everything in the circle. */
  trapPulse(x: number, z: number, radius: number): void {
    for (const e of this.pool) {
      if (!ready(e)) continue;
      const p = e.actor.root.position;
      if ((p.x - x) ** 2 + (p.z - z) ** 2 > radius * radius) continue;
      const slowed = e.slowUntil > this.time ? e.slowFactor : 1;
      e.slowFactor = Math.min(slowed, TRAP_SLOW);
      e.slowUntil = Math.max(e.slowUntil, this.time + TRAP_SLOW);
      this.fx.burst(p.x, 0.4, p.z, 0xb08a5a, 2, 3, 0.12);
      this.damage(e, 1, NO_PUSH, true);
    }
  }

  /** Hits every foe within reach of a point, pushing them away. */
  cleave(p: THREE.Vector3, reach: number, amount: number, push = 4): void {
    for (const e of this.pool) {
      if (!ready(e)) continue;
      const q = e.actor.root.position;
      const away = new THREE.Vector3(q.x - p.x, 0, q.z - p.z);
      if (away.length() > reach + ENEMIES[e.kind].hitRadius * 0.5) continue;
      this.damage(e, amount, away.normalize().multiplyScalar(push));
    }
  }

  /** Shoves and stuns every foe but the boss within a radius, then damages them all. */
  bash(p: THREE.Vector3, radius: number, push: number, stun: number, amount: number): void {
    for (const e of this.pool) {
      if (!ready(e)) continue;
      const q = e.actor.root.position;
      const away = new THREE.Vector3(q.x - p.x, 0, q.z - p.z);
      const d = away.length();
      if (d > radius) continue;
      away.normalize();
      if (e.kind !== 'Boss') {
        q.addScaledVector(away, push * (1 - d / (radius + 1)));
        e.frozenUntil = Math.max(e.frozenUntil, this.time + stun);
      }
      this.damage(e, amount, NO_PUSH);
    }
  }

  /** Damages every foe within a radius of a point, with knockback away from it. */
  blast(x: number, z: number, radius: number, amount: number, push = 3, quiet = false): void {
    for (const e of this.pool) {
      if (!ready(e)) continue;
      const p = e.actor.root.position;
      const away = new THREE.Vector3(p.x - x, 0, p.z - z);
      if (away.length() > radius + ENEMIES[e.kind].hitRadius * 0.4) continue;
      this.damage(e, amount, away.normalize().multiplyScalar(push), quiet);
    }
  }

  /** Moves every foe for a frame. Returns the total melee damage per second from foes touching the hero. */
  update(dt: number): number {
    this.time += dt;
    this.frame++;
    const hero = this.hooks.hero();
    const heroInside = this.hooks.heroInside();
    const speedMul = this.hooks.speedMul();
    let touching = 0;
    const crowded = this.activeCount > 40;
    let index = -1;
    for (const e of this.pool) {
      index++;
      if (!e.active) continue;
      // With a big horde, each skeleton re-poses every other frame.
      const frozen = e.alive && e.frozenUntil > this.time;
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
        e.retarget = 0.8 + rand() * 0.4;
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
            this.spawn('Minion', p.x + Math.cos(a) * 2.5, p.z + Math.sin(a) * 2.5, e.side, e.inside);
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
          this.hooks.castOrb(p, ranged!.damage, ranged!.spread ?? 1);
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
        if (this.economy.hitGate(e.side, stats.dps * dt)) {
          e.thorn += THORN_DPS * dt;
          if (e.thorn >= 1) {
            const owed = Math.floor(e.thorn);
            e.thorn -= owed;
            this.damage(e, owed, NO_PUSH, true);
            if (!e.alive) continue;
          }
        }
      } else if (chasing && dist < 1.3) {
        touching += stats.dps;
      } else if (dist > 1e-3) {
        prev.x = p.x;
        prev.z = p.z;
        const step = stats.speed * (e.elite === 'swift' ? 1.6 : 1) * speedMul * dt * (e.slowUntil > this.time ? e.slowFactor : 1);
        p.x += (dx / dist) * step;
        p.z += (dz / dist) * step;
        this.checkStuck(e, dt);
      }
      if (dist > 1e-3) e.actor.root.rotation.y = Math.atan2(dx, dz);

      // Keep the horde from stacking into one point.
      for (const o of this.pool) {
        if (o === e || !ready(o)) continue;
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
      pushOutOfObstacles(p, 0.55, this.obstacles);
      collideWalls(p, prev, 0.55, (side) => !this.economy.hasGate(side));
    }
    return touching;
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
}
