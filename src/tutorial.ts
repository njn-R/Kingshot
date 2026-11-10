import * as THREE from 'three';
import type { Economy } from './economy';
import { save } from './save';

const MOVE_DISTANCE = 3;
const WOOD_NEEDED = 15;
const KILLS_NEEDED = 3;
const LAST_TIP_TIME = 6;

const el = (id: string) => document.getElementById(id)!;
const touch = matchMedia('(pointer: coarse)').matches;

/** Guides a first-time player through moving, chopping, building and fighting. */
export class Tutorial {
  private step = 0;
  private travelled = 0;
  private last: THREE.Vector3 | null = null;
  private timer = LAST_TIP_TIME;
  private time = 0;
  private marker: THREE.Mesh;
  private skip = () => this.finish();
  done = false;

  constructor(private scene: THREE.Scene) {
    this.marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.75, 1.5, 4).rotateX(Math.PI),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 1.5, 0.4), toneMapped: false }),
    );
    this.marker.visible = false;
    scene.add(this.marker);
    el('tipSkip').addEventListener('click', this.skip);
    el('tip').style.display = 'flex';
    this.say(touch ? 'Drag anywhere to walk.' : 'Walk with WASD or the arrow keys.');
  }

  /** Waves wait until the player has built something. */
  get holdWaves(): boolean { return this.step < 3; }

  private say(text: string): void { el('tipText').textContent = text; }

  private point(at: { x: number; z: number } | null, height: number): void {
    this.marker.visible = !!at;
    if (at) this.marker.position.set(at.x, height + Math.sin(this.time * 5) * 0.3, at.z);
  }

  update(dt: number, hero: THREE.Vector3, economy: Economy, kills: number): void {
    this.time += dt;
    this.marker.rotation.y += dt * 2.5;
    if (this.step === 0) {
      if (this.last) this.travelled += this.last.distanceTo(hero);
      this.last = hero.clone();
      if (this.travelled >= MOVE_DISTANCE) { this.step = 1; this.say('Stand beside the marked tree to chop 15 wood.'); }
    } else if (this.step === 1) {
      this.point(economy.nearestTree(hero), 6);
      if (economy.wood >= WOOD_NEEDED) { this.step = 2; this.say('Stand on the marked ring to build a barricade.'); }
    } else if (this.step === 2) {
      this.point(economy.nearestGatePad(hero), 4.5);
      if (economy.stats.gates > 0) {
        this.step = 3;
        this.point(null, 0);
        this.say('They come! You shoot on your own, so keep moving.');
      }
    } else if (this.step === 3) {
      if (kills >= KILLS_NEEDED) { this.step = 4; this.say('Grab the gold. Wood and gold build towers on the other rings.'); }
    } else {
      this.timer -= dt;
      if (this.timer <= 0) this.finish();
    }
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    save.finishTutorial();
    this.dispose();
  }

  dispose(): void {
    this.scene.remove(this.marker);
    el('tipSkip').removeEventListener('click', this.skip);
    el('tip').style.display = 'none';
  }
}
