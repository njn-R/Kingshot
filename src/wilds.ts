import * as THREE from 'three';
import type { Assets } from './assets';
import { CAMP, GATE_SIDES, WORLD_LIMIT, type Obstacle } from './world';

export type SiteKind = 'camp' | 'chest';

/** A skeleton camp to raze or a chest to open, out in the meadow and forest. */
export interface Site {
  kind: SiteKind; x: number; z: number; root: THREE.Group; fill: THREE.Mesh; flame: THREE.Object3D | null;
  progress: number; woke: boolean; obstacle: Obstacle | null;
}

const SITE_RADIUS = 2.4;
const WAKE_RANGE = 13;
const OPEN_TIME: Record<SiteKind, number> = { chest: 1.2, camp: 3 };
const MAX_CHESTS = 3;
const START_CHESTS = 2;
/** Waves after which a new camp rises, and how long a razed camp stays gone. */
const CAMP_WAVES = [2, 6];
const CAMP_RETURN = 4;
const LABEL_W = 360;
const LABEL_H = 150;

export interface WildsHooks {
  /** Wakes the guards when the hero comes near. */
  guards(site: Site): void;
  /** A chest was opened or a camp razed. */
  opened(site: Site): void;
  announce(text: string): void;
  /** Distance from (x, z) to the nearest ring the economy owns. */
  padClearance(x: number, z: number): number;
}

/** Clones a model resting on y=0, centred, with its longest side `length` long. */
export function normalized(assets: Assets, name: string, length: number): THREE.Group {
  const src = assets.scene(name).clone();
  const box = new THREE.Box3().setFromObject(src);
  const size = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  src.position.set(-c.x, -box.min.y, -c.z);
  const wrap = new THREE.Group();
  wrap.add(src);
  wrap.scale.setScalar(length / Math.max(size.x, size.y, size.z));
  wrap.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return wrap;
}

function tint(obj: THREE.Object3D, color: THREE.Color): void {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
    mat.color.multiply(color);
    mesh.material = mat;
  });
}

function label(title: string, blurb: string, foot: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = LABEL_W;
  canvas.height = LABEL_H;
  const g = canvas.getContext('2d')!;
  g.textAlign = 'center';
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(30,18,10,0.9)';
  const text = (s: string, y: number, font: string, fill: string) => {
    g.font = font;
    g.strokeText(s, LABEL_W / 2, y);
    g.fillStyle = fill;
    g.fillText(s, LABEL_W / 2, y);
  };
  text(title, 40, 'bold 36px Georgia, serif', '#fbeed3');
  text(blurb, 82, 'bold 25px Georgia, serif', '#bfe6ff');
  text(foot, 128, 'bold 30px Georgia, serif', color);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, fog: false, toneMapped: false }));
  sprite.scale.set(5.6, 5.6 * LABEL_H / LABEL_W, 1);
  sprite.position.y = 3.6;
  sprite.renderOrder = 10;
  return sprite;
}

export class Wilds {
  private sites: Site[] = [];
  private campReturns: number[] = [];

  constructor(private scene: THREE.Scene, private assets: Assets, private obstacles: Obstacle[], private openSides: number[], private hooks: WildsHooks) {}

  get all(): readonly Site[] { return this.sites; }
  get camps(): Site[] { return this.sites.filter((s) => s.kind === 'camp'); }

  reset(): void {
    for (const s of [...this.sites]) this.remove(s);
    this.campReturns = [];
    for (let i = 0; i < START_CHESTS; i++) this.add('chest');
  }

  /** New camps rise and chests appear as the waves go by. */
  waveCleared(wave: number): void {
    const returning = this.campReturns.filter((w) => w === wave).length;
    this.campReturns = this.campReturns.filter((w) => w !== wave);
    const rising = (CAMP_WAVES.includes(wave) ? 1 : 0) + returning;
    for (let i = 0; i < rising; i++) this.add('camp');
    if (rising > 0) this.hooks.announce('A skeleton camp rises in the woods');
    if (wave % 2 === 0 && this.sites.filter((s) => s.kind === 'chest').length < MAX_CHESTS) this.add('chest');
  }

  /** Tracks how far each site has been opened; returns the chest or camp the hero stands in, if any. */
  update(dt: number, hero: THREE.Vector3, time: number, wave: number): void {
    for (const s of [...this.sites]) {
      const d = Math.hypot(hero.x - s.x, hero.z - s.z);
      if (!s.woke && d < WAKE_RANGE) {
        s.woke = true;
        this.hooks.guards(s);
      }
      const inside = d < SITE_RADIUS;
      s.progress = Math.max(0, s.progress + (inside ? dt : -dt * 0.5));
      s.fill.scale.setScalar(Math.max(0.001, s.progress / OPEN_TIME[s.kind]));
      if (s.flame) {
        s.flame.scale.set(1 + Math.sin(time * 9 + s.x) * 0.12, 1.5 + Math.sin(time * 13 + s.z) * 0.2, 1);
      }
      if (s.progress >= OPEN_TIME[s.kind]) {
        this.hooks.opened(s);
        this.remove(s);
        if (s.kind === 'camp') this.campReturns.push(wave + CAMP_RETURN);
      }
    }
  }

  private remove(s: Site): void {
    this.sites.splice(this.sites.indexOf(s), 1);
    this.scene.remove(s.root);
    s.root.traverse((o) => {
      const sprite = o as THREE.Sprite;
      if (sprite.isSprite) sprite.material.map?.dispose();
    });
    if (s.obstacle) {
      const i = this.obstacles.indexOf(s.obstacle);
      if (i >= 0) this.obstacles.splice(i, 1);
    }
  }

  /** A clear spot in the right band around the walls, away from roads, rings and other sites. */
  private findSpot(kind: SiteKind): { x: number; z: number } | null {
    const [near, far, room] = kind === 'chest' ? [CAMP + 6, CAMP + 24, 2.8] : [CAMP + 13, CAMP + 27, 3.6];
    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 260; i++) {
      const x = (Math.random() - 0.5) * 2 * far;
      const z = (Math.random() - 0.5) * 2 * far;
      const d = Math.max(Math.abs(x), Math.abs(z));
      if (d < near || d > Math.min(far, WORLD_LIMIT - 5)) continue;
      const onRoad = this.openSides.some((side) => {
        const [nx, nz] = GATE_SIDES[side];
        return x * nx + z * nz > 0 && Math.abs(x * nz + z * nx) < (kind === 'camp' ? 7 : 4);
      });
      if (onRoad) continue;
      let clearance = this.hooks.padClearance(x, z) - SITE_RADIUS;
      for (const o of this.obstacles) clearance = Math.min(clearance, Math.hypot(o.x - x, o.z - z) - o.r);
      if (clearance < room) continue;
      let spacing = Infinity;
      for (const s of this.sites) spacing = Math.min(spacing, Math.hypot(s.x - x, s.z - z));
      const score = Math.min(spacing, 24) + Math.random() * 4;
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
    return best;
  }

  private add(kind: SiteKind): void {
    const spot = this.findSpot(kind);
    if (!spot) return;
    const root = new THREE.Group();
    root.position.set(spot.x, 0, spot.z);
    const flat = (geometry: THREE.BufferGeometry, color: number, opacity: number, y: number) => {
      const mesh = new THREE.Mesh(geometry.rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity }));
      mesh.position.y = y;
      root.add(mesh);
      return mesh;
    };
    const camp = kind === 'camp';
    const ringColor = camp ? 0xff5a4a : 0xffd24a;
    flat(new THREE.CircleGeometry(SITE_RADIUS, 40), 0x2b1a10, 0.45, 0.05);
    const fill = flat(new THREE.CircleGeometry(SITE_RADIUS - 0.12, 40), camp ? 0xd0402a : 0xf0c04a, 0.8, 0.06);
    fill.scale.setScalar(0.001);
    flat(new THREE.RingGeometry(SITE_RADIUS - 0.12, SITE_RADIUS + 0.08, 48), ringColor, 1, 0.07);

    let flame: THREE.Object3D | null = null;
    let obstacle: Obstacle | null = null;
    // Props sit on the far side of the ring from the walls.
    const out = Math.atan2(spot.x, spot.z);
    const ox = Math.sin(out), oz = Math.cos(out);
    if (camp) {
      const tent = normalized(this.assets, 'tent', 3.4);
      tint(tent, new THREE.Color(0.45, 0.4, 0.5));
      tent.position.set(ox * 3.6, 0, oz * 3.6);
      tent.rotation.y = out + Math.PI;
      root.add(tent);
      obstacle = { x: spot.x + ox * 3.6, z: spot.z + oz * 3.6, r: 1.4 };
      this.obstacles.push(obstacle);
      for (const side of [-1, 1]) {
        const banner = normalized(this.assets, 'flag-pennant', 3.2);
        tint(banner, new THREE.Color(0.55, 0.25, 0.7));
        banner.position.set(ox * 2.6 + oz * side * 3, 0, oz * 2.6 - ox * side * 3);
        root.add(banner);
      }
      for (let i = 0; i < 5; i++) {
        const a = out + Math.PI + (i - 2) * 0.5;
        const rock = normalized(this.assets, 'rock_single_C', 0.9);
        tint(rock, new THREE.Color(1.3, 1.25, 1.1));
        rock.position.set(Math.sin(a) * (SITE_RADIUS + 0.9), 0, Math.cos(a) * (SITE_RADIUS + 0.9));
        root.add(rock);
      }
      flame = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.6, 2.6), toneMapped: false }));
      flame.position.set(ox * 2 - oz * 1.6, 0.9, oz * 2 + ox * 1.6);
      root.add(flame);
      root.add(label('Skeleton Camp', 'Adds foes to every wave', 'Stand here to raze', '#ff9a80'));
    } else {
      const chest = normalized(this.assets, 'crate_open', 1.7);
      chest.position.set(ox * 0.2, 0, oz * 0.2);
      chest.rotation.y = out;
      root.add(chest);
      const chestTop = new THREE.Box3().setFromObject(chest).max.y * 0.8;
      const coin =new THREE.MeshStandardMaterial({ color: 0xf5c33b, metalness: 0.5, roughness: 0.3, emissive: 0x7a4f00, emissiveIntensity: 0.9 });
      for (let i = 0; i < 4; i++) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.08, 12), coin);
        c.position.set((i - 1.5) * 0.3, chestTop + (i % 2) * 0.1, (i % 2) * 0.2 - 0.1);
        c.rotation.x = 0.6 + i * 0.3;
        root.add(c);
      }
      root.add(label('Treasure', 'Watch for its guards', 'Stand here to open', '#ffd76a'));
    }
    this.scene.add(root);
    this.sites.push({ kind, x: spot.x, z: spot.z, root, fill, flame, progress: 0, woke: false, obstacle });
  }
}
