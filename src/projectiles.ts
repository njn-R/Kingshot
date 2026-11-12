import * as THREE from 'three';
import type { Assets } from './assets';
import { ENEMIES } from './data';
import type { Fx } from './fx';
import { ready, type Enemy } from './horde';
import type { Sfx } from './sfx';

const ARROW_SPEED = 42;
const ARROW_SCALE = 2.2;
const ARROW_LIFE = 0.9;
/** Angle between the bolts of one multi-shot. */
const SPREAD = 0.16;
const TRAIL_LENGTH = 3.2;
const ORB_SPEED = 13;
const ORB_LIFE = 2.2;
const BOULDER_FLIGHT = 0.8;
const BOULDER_ARC = 9;
const BURN_TIME = 3;
export const BURN_RADIUS = 3;
const BURN_TICK = 0.5;
const STORM_TARGETS = 3;
const STORM_RANGE = 7;
const DUST = 0xb9a584;

interface Arrow { obj: THREE.Object3D; trail: THREE.Object3D; travelled: number; dir: THREE.Vector3; life: number; damage: number; pierce: number; hit: Set<Enemy>; chain: boolean }
interface Orb { mesh: THREE.Mesh; dir: THREE.Vector3; life: number; damage: number }
interface Boulder { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t: number; damage: number; radius: number; burn: boolean }
interface Fire { mesh: THREE.Mesh; x: number; z: number; r: number; life: number; tick: number }

const orbGeometry = new THREE.IcosahedronGeometry(0.42, 1);
const orbMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 0.7, 2.6), toneMapped: false });
const boulderGeometry = new THREE.IcosahedronGeometry(0.62, 0);
const boulderMaterial = new THREE.MeshStandardMaterial({ color: 0x8b8580, roughness: 0.95, flatShading: true });
const fireGeometry = new THREE.CircleGeometry(BURN_RADIUS, 32).rotateX(-Math.PI / 2);
const fireMaterial = new THREE.MeshBasicMaterial({ color: 0xff6a20, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false });
const NO_PUSH = new THREE.Vector3();

export interface ProjectileHooks {
  /** Every pooled foe; only those `ready` can be hit. */
  pool(): readonly Enemy[];
  damage(e: Enemy, amount: number, dir: THREE.Vector3, quiet?: boolean): void;
  hero(): THREE.Vector3;
  /** An orb struck the hero. */
  heroHit(damage: number): void;
  /** Something hit the ground hard enough to shake the view. */
  shake(amount: number): void;
}

/** Bolts, hexer orbs, catapult boulders and burning ground. */
export class Projectiles {
  private arrows: Arrow[] = [];
  private orbs: Orb[] = [];
  private boulders: Boulder[] = [];
  private fires: Fire[] = [];
  private arrowModel: THREE.Object3D;

  constructor(private scene: THREE.Scene, assets: Assets, private fx: Fx, private sfx: Sfx, private hooks: ProjectileHooks) {
    this.arrowModel = makeArrowModel(assets);
  }

  clear(): void {
    for (const a of this.arrows) this.scene.remove(a.obj);
    for (const o of this.orbs) this.scene.remove(o.mesh);
    for (const b of this.boulders) this.scene.remove(b.mesh);
    for (const f of this.fires) this.scene.remove(f.mesh);
    this.arrows = [];
    this.orbs = [];
    this.boulders = [];
    this.fires = [];
  }

  /** Shoots `count` bolts fanned around the line to the target. A chained bolt arcs lightning from the first foe it hits. */
  fire(from: THREE.Vector3, target: THREE.Vector3, damage: number, count: number, pierce: number, chain = false): void {
    const aim = target.clone().setY(1.5).sub(from).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < count; i++) {
      const dir = aim.clone().applyAxisAngle(up, (i - (count - 1) / 2) * SPREAD);
      const obj = this.arrowModel.clone();
      obj.position.copy(from);
      obj.lookAt(from.clone().add(dir));
      this.scene.add(obj);
      const trail = obj.getObjectByName('trail')!;
      trail.scale.z = 0.01;
      this.arrows.push({ obj, trail, travelled: 0, dir, life: ARROW_LIFE, damage, pierce, hit: new Set(), chain });
    }
  }

  /** Lightning leaps from a struck foe to a few more nearby. */
  arc(from: Enemy, damage: number): void {
    const p = from.actor.root.position;
    const near = this.hooks.pool()
      .filter((e) => e !== from && ready(e) && e.actor.root.position.distanceTo(p) < STORM_RANGE)
      .sort((a, b) => a.actor.root.position.distanceTo(p) - b.actor.root.position.distanceTo(p))
      .slice(0, STORM_TARGETS);
    for (const e of near) {
      const q = e.actor.root.position;
      for (let k = 1; k <= 4; k++) {
        const t = k / 5;
        this.fx.burst(p.x + (q.x - p.x) * t, 1.4, p.z + (q.z - p.z) * t, 0xa8e0ff, 2, 2, 0.14);
      }
      this.hooks.damage(e, damage, NO_PUSH);
    }
    if (near.length) this.sfx.beacon();
  }

  /** Hurls a boulder that lands on the target and damages everything within `radius`; `burn` leaves fire behind. */
  lob(from: THREE.Vector3, target: THREE.Vector3, radius: number, burn: boolean, damage: number): void {
    const mesh = new THREE.Mesh(boulderGeometry, boulderMaterial);
    mesh.castShadow = true;
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.sfx.shoot(true);
    this.boulders.push({ mesh, from: from.clone(), to: target.clone().setY(0.4), t: 0, damage, radius, burn });
  }

  /** A fan of `spread` orbs flying from a caster toward the hero. */
  castOrb(from: THREE.Vector3, damage: number, spread = 1): void {
    const hero = this.hooks.hero();
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

  /** Sets a circle of ground burning; foes standing in it take a point of damage every half second. */
  ignite(x: number, z: number, r = BURN_RADIUS, life = BURN_TIME): void {
    const mesh = new THREE.Mesh(fireGeometry, fireMaterial);
    mesh.position.set(x, 0.1, z);
    this.scene.add(mesh);
    this.fires.push({ mesh, x, z, r, life, tick: 0 });
  }

  update(dt: number): void {
    this.updateArrows(dt);
    this.updateBoulders(dt);
    this.updateFires(dt);
    this.updateOrbs(dt);
  }

  private updateArrows(dt: number): void {
    const pool = this.hooks.pool();
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.obj.position.addScaledVector(a.dir, ARROW_SPEED * dt);
      a.travelled += ARROW_SPEED * dt;
      a.trail.scale.z = Math.max(0.01, Math.min(1, a.travelled / TRAIL_LENGTH));
      a.life -= dt;
      let spent = false;
      for (const e of pool) {
        if (!ready(e) || a.hit.has(e)) continue;
        const p = e.actor.root.position;
        const dx = p.x - a.obj.position.x;
        const dz = p.z - a.obj.position.z;
        const r = ENEMIES[e.kind].hitRadius;
        if (dx * dx + dz * dz < r * r) {
          this.hooks.damage(e, a.damage, a.dir);
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
      this.hooks.shake(0.14);
      for (const e of this.hooks.pool()) {
        if (!ready(e)) continue;
        const p = e.actor.root.position;
        const away = new THREE.Vector3(p.x - x, 0, p.z - z);
        if (away.length() > b.radius + ENEMIES[e.kind].hitRadius * 0.4) continue;
        this.hooks.damage(e, b.damage, away.normalize().multiplyScalar(3));
      }
    }
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
        for (const e of this.hooks.pool()) {
          if (!ready(e)) continue;
          const p = e.actor.root.position;
          if ((p.x - f.x) ** 2 + (p.z - f.z) ** 2 < f.r * f.r) this.hooks.damage(e, 1, NO_PUSH, true);
        }
      }
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        this.fires.splice(i, 1);
      }
    }
  }

  private updateOrbs(dt: number): void {
    const hero = this.hooks.hero();
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const o = this.orbs[i];
      o.mesh.position.addScaledVector(o.dir, ORB_SPEED * dt);
      o.life -= dt;
      const hit = (o.mesh.position.x - hero.x) ** 2 + (o.mesh.position.z - hero.z) ** 2 < 1.1;
      if (hit) {
        this.fx.burst(hero.x, 1.5, hero.z, 0xc070ff, 12, 7, 0.16);
        this.hooks.heroHit(o.damage);
      }
      if (hit || o.life <= 0) {
        this.scene.remove(o.mesh);
        this.orbs.splice(i, 1);
      }
    }
  }
}

/** Wraps the arrow so its long axis points along +Z, with a streak behind it fading to nothing at the tail. */
function makeArrowModel(assets: Assets): THREE.Object3D {
  const src = assets.scene('arrow_bow').clone();
  const size = new THREE.Box3().setFromObject(src).getSize(new THREE.Vector3());
  if (size.y >= size.x && size.y >= size.z) src.rotation.x = Math.PI / 2;
  else if (size.x >= size.z) src.rotation.y = Math.PI / 2;
  const wrap = new THREE.Group();
  wrap.add(src);
  wrap.scale.setScalar(ARROW_SCALE);

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
