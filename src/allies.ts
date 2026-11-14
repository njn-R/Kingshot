import * as THREE from 'three';
import { Actor } from './actor';
import type { Assets } from './assets';
import { collideWalls, type Obstacle } from './world';

export interface AllyContext {
  hero: THREE.Vector3;
  nearest(from: THREE.Vector3, range: number): THREE.Vector3 | null;
  shoot(from: THREE.Vector3, target: THREE.Vector3, damage: number, count: number): void;
  /** Fire-rate multiplier from relics. */
  rate?: number;
}

/** Shot interval, damage, bolts per shot and range at each level. */
const LEVELS = [
  { interval: 0.75, damage: 2, count: 1, range: 15 },
  { interval: 0.52, damage: 2, count: 1, range: 16 },
  { interval: 0.52, damage: 3, count: 2, range: 17 },
];
const SLOTS: Array<[number, number]> = [[-2.4, 1.8], [2.4, 1.8]];
const TELEPORT = 30;

/** A companion who follows the hero and shoots on their own. */
export class Ally {
  readonly actor: Actor;
  level = 1;
  private cooldown = 0;

  constructor(private scene: THREE.Scene, assets: Assets, model: string, weapon: string, private slot: number, private obstacles: Obstacle[], public wavesLeft = Infinity) {
    this.actor = new Actor(assets, model, 1);
    let hand: THREE.Object3D | undefined;
    this.actor.root.traverse((o) => { if (/^handslot\.?r$/i.test(o.name)) hand = o; });
    if (hand) {
      const held = assets.scene(weapon).clone();
      held.traverse((o) => { o.castShadow = (o as THREE.Mesh).isMesh; });
      hand.add(held);
    }
    this.actor.play('Idle_A');
    scene.add(this.actor.root);
  }

  place(x: number, z: number): void {
    this.actor.root.position.set(x, 0, z);
  }

  update(dt: number, ctx: AllyContext): void {
    const p = this.actor.root.position;
    const [sx, sz] = SLOTS[this.slot % SLOTS.length];
    const gx = ctx.hero.x + sx, gz = ctx.hero.z + sz;
    const dx = gx - p.x, dz = gz - p.z;
    const d = Math.hypot(dx, dz);
    if (d > TELEPORT) {
      p.set(gx, 0, gz);
    } else if (d > 1.2) {
      const prev = { x: p.x, z: p.z };
      const step = Math.min(d, (4 + d * 2.5) * dt, 17 * dt);
      p.x += (dx / d) * step;
      p.z += (dz / d) * step;
      collideWalls(p, prev, 0.5, () => true);
      for (const o of this.obstacles) {
        const ox = p.x - o.x, oz = p.z - o.z;
        const min = o.r + 0.5;
        const od = Math.hypot(ox, oz);
        if (od < min && od > 1e-4) { p.x = o.x + (ox / od) * min; p.z = o.z + (oz / od) * min; }
      }
      this.actor.root.rotation.y = Math.atan2(dx, dz);
    }
    this.actor.play(d > 1.2 ? 'Running_A' : 'Idle_A');

    const stats = LEVELS[this.level - 1];
    this.cooldown -= dt;
    const target = ctx.nearest(p, stats.range);
    if (target) {
      this.actor.root.rotation.y = Math.atan2(target.x - p.x, target.z - p.z);
      if (this.cooldown <= 0) {
        this.cooldown = stats.interval / (ctx.rate ?? 1);
        ctx.shoot(p.clone().setY(1.6), target, stats.damage, stats.count);
      }
    }
    this.actor.update(dt);
  }

  dispose(): void {
    this.scene.remove(this.actor.root);
  }
}
