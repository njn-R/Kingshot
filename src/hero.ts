import * as THREE from 'three';
import { Actor } from './actor';
import type { Assets } from './assets';
import type { Weapon } from './data';
import { WORLD_LIMIT, collideWalls, pushOutOfObstacles, type Obstacle } from './world';

export const CHAR_SCALE = 1.1;
const TURN_RATE = 14;

export interface Input { x: number; z: number }

/**
 * The player's character: a stable root the camera and economy follow, holding the animated body,
 * cape, crest and weapon that change with the chosen class.
 */
export class Hero {
  /** Position and facing live here; swapping the body keeps them. */
  readonly root = new THREE.Group();
  actor!: Actor;
  weapon!: Weapon;
  private held: THREE.Object3D | null = null;
  private cape = new THREE.Group();
  private model = '';

  constructor(private assets: Assets, scene: THREE.Scene) {
    scene.add(this.root);
  }

  get position(): THREE.Vector3 { return this.root.position; }

  /** Builds (or rebuilds) the body for a model, dressed in an accent colour; `crest` adds the Warden's helmet plume. */
  setBody(model: string, accent: number, crest: boolean): void {
    if (this.model === model && this.actor) return;
    if (this.actor) this.root.remove(this.actor.root);
    this.model = model;
    this.actor = new Actor(this.assets, model, CHAR_SCALE);
    this.root.add(this.actor.root);
    this.held = null;
    this.dress(accent, crest);
    if (this.weapon) this.equip(this.weapon);
    this.actor.play('Idle_A');
  }

  /** Puts a weapon in the hero's hand; its stats apply from the next shot. */
  equip(weapon: Weapon): void {
    this.weapon = weapon;
    let hand: THREE.Object3D | undefined;
    this.actor.root.traverse((o) => { if (/^handslot\.?r$/i.test(o.name)) hand = o; });
    if (!hand) { console.warn('Hero hand bone not found'); return; }
    if (this.held) this.held.parent?.remove(this.held);
    const model = this.assets.scene(weapon.model).clone();
    model.traverse((o) => { o.castShadow = (o as THREE.Mesh).isMesh; });
    hand.add(model);
    this.held = model;
  }

  /** Gives the stock adventurer a cape and, for the Warden, a crest, so the hero is this game's own. */
  private dress(accent: number, crest: boolean): void {
    const cloth = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.75, side: THREE.DoubleSide });
    const geometry = new THREE.PlaneGeometry(1.05, 1.55, 6, 8).translate(0, -0.78, 0);
    const pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const k = -pos.getY(i) / 1.55;
      pos.setX(i, pos.getX(i) * (0.72 + k * 0.5));
      pos.setZ(i, Math.sin(pos.getX(i) * 5) * 0.05 * k);
    }
    geometry.computeVertexNormals();
    const cape = new THREE.Mesh(geometry, cloth);
    cape.castShadow = true;
    this.cape = new THREE.Group();
    this.cape.position.set(0, 1.55, -0.3);
    this.cape.add(cape);
    this.actor.root.add(this.cape);
    if (!crest) return;

    let head: THREE.Object3D | undefined;
    this.actor.root.traverse((o) => { if (/^head$/i.test(o.name)) head = o; });
    if (!head) { console.warn('Hero head bone not found'); return; }
    const gold = new THREE.MeshStandardMaterial({ color: 0xe6b84a, roughness: 0.4, metalness: 0.6 });
    const plume = new THREE.Group();
    plume.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.7), gold));
    for (let i = 0; i < 5; i++) {
      const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.62 - i * 0.05, 5), cloth);
      fin.position.set(0, 0.28, 0.3 - i * 0.16);
      fin.rotation.x = -0.3 - i * 0.12;
      plume.add(fin);
    }
    this.root.updateMatrixWorld(true);
    const at = head.getWorldPosition(new THREE.Vector3());
    this.actor.root.add(plume);
    plume.position.set(0, (at.y - this.root.position.y) / CHAR_SCALE + 1.08, 0);
    this.root.updateMatrixWorld(true);
    head.attach(plume);
  }

  reset(): void {
    this.actor.reset();
    this.actor.play('Idle_A');
    this.root.position.set(0, 0, 2);
    this.root.rotation.y = 0;
  }

  /** Walks by `input` at `speed`, staying inside the world and out of walls and props. Returns whether the hero moved. */
  move(dt: number, input: Input, speed: number, obstacles: readonly Obstacle[], extra?: (p: THREE.Vector3, prev: { x: number; z: number }) => void): boolean {
    if (input.x === 0 && input.z === 0) return false;
    const p = this.root.position;
    const prev = { x: p.x, z: p.z };
    p.x += input.x * speed * dt;
    p.z += input.z * speed * dt;
    p.x = THREE.MathUtils.clamp(p.x, -WORLD_LIMIT, WORLD_LIMIT);
    p.z = THREE.MathUtils.clamp(p.z, -WORLD_LIMIT, WORLD_LIMIT);
    // The hero's own barricades open for them, so every gate is passable.
    collideWalls(p, prev, 0.7, () => true);
    extra?.(p, prev);
    pushOutOfObstacles(p, 0.7, obstacles);
    return true;
  }

  /** Turns smoothly toward an angle. */
  face(angle: number, dt: number): void {
    const cur = this.root.rotation.y;
    const diff = Math.atan2(Math.sin(angle - cur), Math.cos(angle - cur));
    this.root.rotation.y = cur + diff * Math.min(1, dt * TURN_RATE);
  }

  /** Plays the right animation and lets the cape flutter. */
  animate(dt: number, moving: boolean, chopping: boolean, time: number): void {
    this.actor.play(moving ? 'Running_A' : chopping ? 'Interact' : 'Idle_A');
    const flutter = moving ? 0.72 + Math.sin(time * 15) * 0.09 : 0.14 + Math.sin(time * 2.4) * 0.03;
    this.cape.rotation.x += (flutter - this.cape.rotation.x) * Math.min(1, dt * 9);
    this.actor.update(dt);
  }
}
