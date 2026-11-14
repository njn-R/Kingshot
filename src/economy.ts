import * as THREE from 'three';
import type { Assets } from './assets';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Actor } from './actor';
import { CHAR_SCALE } from './hero';
import { CAMP, GATE_SIDES, insideCamp, type Obstacle } from './world';

/** Choppable trees in the meadow outside each wall, as [distance from centre, offset along the wall]. */
const OUTER_TREES: Array<[number, number]> = [[CAMP + 6, -8], [CAMP + 6, 8], [CAMP + 9, -13], [CAMP + 9, 13]];
import { BASE_TOWER_INTERVAL, KEEP_TIERS, TOWERS, UPGRADES, type TowerKind, type UpgradeKey, type Upgrades } from './data';
import { buildingModel, type MapDef } from './maps';

const CHOP_RANGE = 2.9;
const LOGS_PER_TREE = 5;
const TREE_REGROW = 14;
const MAX_STACK = 9;
const PAD_RADIUS = 2.2;
const PAY_INTERVAL = 0.05;
const FILL_TIME = 2;
// Each siege model's firing direction, relative to rotation 0 facing +Z.
const HEAD_FACING: Record<'ballista' | 'catapult', number> = { ballista: -Math.PI / 2, catapult: -Math.PI / 2 };
const GATE_HP = 120;
/** Barricade health multiplier at levels 1 to 3. */
const GATE_HP_SCALE = [1, 2, 2.5];
const UPGRADE_RADIUS = 1.5;
const UPGRADE_RING = 0xa8e0ff;
const BUILD_RING = 0xffe9b0;
const WORKER_SPEED = 5.5;
const WORKER_CHOP = 0.9;
const WORKER_LOAD = 3;
const TRAP_RADIUS = 2.6;
const TRAP_TICK = 0.5;
const LABEL_W = 360;
const LABEL_H = 150;
const LOCKED_RING = 0x8c8478;
const HOUSE_HP = 70;
const MINE_HP = 90;
const HOUSE_INCOME = 5;
const MINE_YIELD = 3;
const MINE_TICK = 5;
const TIER_NAMES = ['', 'I', 'II', 'III'];
/** Longest side of the Keep's model at each tier. */
const KEEP_SIZE = [0, 4.6, 5.8, 7.4];

type Job = 'woodcutter' | 'gatherer';

/** A cottage or the gold mine: something with health that raiders attack. */
export interface Structure { kind: 'house' | 'mine'; x: number; z: number; r: number; hp: number; maxHp: number; root: THREE.Object3D; bar: THREE.Mesh; pad: Pad; nextFeel: number; worker: Actor | null; obstacle: Obstacle; tick: number }

/** A ring the game adds itself, such as a merchant's ware. `buy` returns the next price, or null to remove the ring. */
export interface OfferSpec {
  x: number; z: number; title: string; blurb: string; wood: number; gold: number; minTier?: number; radius?: number;
  buy(): { title: string; blurb: string; wood: number; gold: number; minTier?: number } | null;
}
interface Worker { job: Job; actor: Actor; home: { x: number; z: number }; carry: number; timer: number; tree: Tree | null; hut: THREE.Object3D }
interface Trap { x: number; z: number; timer: number; root: THREE.Object3D }
const GATE_FEEL_GAP = 0.3;

interface Tree { obj: THREE.Object3D; stump: THREE.Object3D; x: number; z: number; logs: number; regrow: number; wobble: number; base: number }
interface Coin { mesh: THREE.Mesh; vy: number; vx: number; vz: number; value: number }
interface Flyer { obj: THREE.Object3D; from: THREE.Vector3; to: () => THREE.Vector3; t: number; dur: number }
interface Pop { obj: THREE.Object3D; t: number; scale: number }
interface Tower { pad: Pad; kind: TowerKind; head: THREE.Object3D; top: THREE.Vector3; cooldown: number; root: THREE.Object3D; level: number; pulses: number; shots: number; height: number }
interface Gate { hp: number; maxHp: number; level: number; root: THREE.Object3D; bar: THREE.Mesh; door: THREE.Group; pad: Pad; nextFeel: number; cooldown: number }
export interface Pad {
  kind: 'tower' | 'gate' | 'upgrade' | 'hut' | 'trap' | 'keep' | 'house' | 'mine' | 'offer'; tower: TowerKind;
  /** The Keep tier needed before this ring takes payment. */
  minTier: number;
  /** Removed on reset rather than cleared: upgrade rings and offers. */
  temp: boolean;
  buy: OfferSpec['buy'] | null; job: Job | null; blurb: string; x: number; z: number; side: number; title: string;
  woodCost: number; goldCost: number; woodPaid: number; goldPaid: number;
  group: THREE.Group; fill: THREE.Mesh; ring: THREE.Mesh; label: THREE.Sprite; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture;
  active: boolean; tick: number; radius: number;
  /** 'build' raises the structure; 'upgrade' raises it to `level`. */
  mode: 'build' | 'upgrade'; level: number;
  /** The tower an upgrade ring belongs to; such rings are removed on reset. */
  owner: Tower | null;
  base: { title: string; wood: number; gold: number; blurb: string };
  /** Set after a purchase, so the next level isn't bought until the hero steps off and back on. */
  waitExit: boolean;
}

/** What has been built, for resuming a run between waves. Indexes are into the rings every run starts with. */
export interface EconomySnapshot { wood: number; gold: number; tier: number; built: Array<[index: number, level: number]> }

export type FeelEvent = 'chop' | 'fell' | 'coin' | 'pay' | 'build' | 'gateHit' | 'gateBreak' | 'workerChop' | 'deliver' | 'mined' | 'ruin' | 'bought';

export interface CombatApi {
  nearest(from: THREE.Vector3, range: number): THREE.Vector3 | null;
  fire(from: THREE.Vector3, target: THREE.Vector3, damage: number, count: number, chain?: boolean): void;
  /** Hurls a boulder that lands on the target and damages everything within `radius`; `burn` leaves fire behind. */
  lob(from: THREE.Vector3, target: THREE.Vector3, radius: number, burn: boolean): void;
  /** Damages and slows every enemy in the circle; `freeze` also holds them still for a moment. */
  aura(x: number, z: number, radius: number, damage: number, slow: number, freeze: boolean): void;
  /** Spikes on the road hurt and slow whatever stands in the circle. */
  trap(x: number, z: number, radius: number): void;
  /** A structure reached a new level. */
  upgraded(text: string, x: number, z: number): void;
  /** The Keep rose to a new tier. */
  keepRaised(tier: number, x: number, z: number): void;
  onResources(): void;
  /** Reports something the player should see and hear. `progress` is only used by 'pay'. */
  feel(event: FeelEvent, x: number, z: number, progress?: number): void;
}

const coinGeometry = new THREE.CylinderGeometry(0.34, 0.34, 0.09, 14);
const coinMaterial = new THREE.MeshStandardMaterial({ color: 0xf5c33b, metalness: 0.5, roughness: 0.3, emissive: 0x7a4f00, emissiveIntensity: 0.6 });

export class Economy {
  wood = 0;
  gold = 0;
  private trees: Tree[] = [];
  private coins: Coin[] = [];
  private flyers: Flyer[] = [];
  private pops: Pop[] = [];
  private pads: Pad[] = [];
  private towers: Tower[] = [];
  private gates: Array<Gate | null> = [null, null, null, null];
  private stack: THREE.Object3D[] = [];
  private workers: Worker[] = [];
  private traps: Trap[] = [];
  private logModel: THREE.Object3D;
  private chopTimer = 0;
  private baseObstacles: number;
  private time = 0;
  private structures: Structure[] = [];
  tier = 1;
  readonly keepSpot: { x: number; z: number };
  private keepModel: THREE.Object3D | null = null;

  constructor(
    private scene: THREE.Scene, private assets: Assets, private obstacles: Obstacle[],
    private hero: THREE.Object3D, private api: CombatApi, private upgrades: Upgrades, private map: MapDef,
  ) {
    this.logModel = this.normalized('resource_lumber', 1.25);
    this.createStack();
    this.createTrees();
    for (const { tower, x, z } of map.pads) {
      const spec = TOWERS[tower];
      const pad = this.createPad('tower', tower, x, z, -1, spec.title, spec.wood, spec.gold, PAD_RADIUS, spec.blurb);
      if (tower === 'beacon') pad.minTier = 2;
      this.pads.push(pad);
    }
    for (const side of map.openSides) {
      const [nx, nz] = GATE_SIDES[side];
      this.pads.push(this.createPad('gate', 'ballista', nx * (CAMP - 5), nz * (CAMP - 5), side, 'Barricade', 15, 0, PAD_RADIUS, 'Blocks a gate'));
      this.pads.push(this.createPad('trap', 'ballista', nx * (CAMP + 7), nz * (CAMP + 7), side, 'Spike Trap', 12, 0, PAD_RADIUS, 'Hurts and slows foes'));
    }

    // The Keep stands in a clear spot, with the ring that raises it beside it.
    this.keepSpot = this.clearSpot(0, 0, [10, 13, 16]);
    this.obstacles.push({ x: this.keepSpot.x, z: this.keepSpot.z, r: 2.3 });
    this.baseObstacles = obstacles.length;
    const keepRing = this.clearSpot(this.keepSpot.x, this.keepSpot.z, [4.4]);
    const first = KEEP_TIERS[0];
    this.pads.push(this.createPad('keep', 'ballista', keepRing.x, keepRing.z, -1, `${first.title} II`, first.wood, first.gold, PAD_RADIUS, first.text));

    const huts: Array<[Job, string, number, number, string, number]> = [
      ['woodcutter', "Woodcutter's Hut", 15, 15, 'A villager chops wood', 1],
      ['gatherer', "Gatherer's Hut", 10, 25, 'A villager picks up gold', 2],
    ];
    for (const [job, title, wood, gold, blurb, tier] of huts) {
      const spot = this.clearSpot(0, 0, [8, 11, 14, 17]);
      const pad = this.createPad('hut', 'ballista', spot.x, spot.z, -1, title, wood, gold, PAD_RADIUS, blurb);
      pad.job = job;
      pad.minTier = tier;
      this.pads.push(pad);
    }
    for (let i = 0; i < 2; i++) {
      const spot = this.clearSpot(0, 0, [12, 15, 18, 21]);
      const pad = this.createPad('house', 'ballista', spot.x, spot.z, -1, 'Cottage', 18, 10, PAD_RADIUS, `+${HOUSE_INCOME} gold each wave`);
      pad.minTier = 2;
      this.pads.push(pad);
    }
    // The mine sits outside a corner of the walls, with a guard tower beside it.
    const mine = this.meadowSpot(-(CAMP + 7), -(CAMP + 7));
    const minePad = this.createPad('mine', 'ballista', mine.x, mine.z, -1, 'Gold Mine', 20, 25, PAD_RADIUS, `+${MINE_YIELD} gold every ${MINE_TICK}s`);
    minePad.minTier = 3;
    this.pads.push(minePad);
    const guard = this.meadowSpot(mine.x + 6.5, mine.z + 1.5);
    const guardPad = this.createPad('tower', 'ballista', guard.x, guard.z, -1, 'Mine Ballista', TOWERS.ballista.wood, TOWERS.ballista.gold, PAD_RADIUS, 'Guards the mine');
    guardPad.minTier = 3;
    this.pads.push(guardPad);
    this.showKeep();
  }

  /** The clearest spot near a point outside the walls, in the meadow before the forest. */
  private meadowSpot(cx: number, cz: number): { x: number; z: number } {
    let best = { x: cx, z: cz };
    let bestScore = -Infinity;
    for (const r of [0, 1.5, 3, 4.5]) {
      for (let i = 0; i < (r ? 12 : 1); i++) {
        const a = (i / 12) * Math.PI * 2;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (Math.max(Math.abs(x), Math.abs(z)) < CAMP + 4) continue;
        let clearance = 6 - r * 0.3;
        for (const o of this.obstacles) clearance = Math.min(clearance, Math.hypot(o.x - x, o.z - z) - o.r);
        for (const p of this.pads) clearance = Math.min(clearance, Math.hypot(p.x - x, p.z - z) - p.radius - 1);
        if (clearance > bestScore) { bestScore = clearance; best = { x, z }; }
      }
    }
    return best;
  }

  /** A clear spot inside the walls near a point, for rings the game places itself. */
  spotNear(x: number, z: number, radii: number[]): { x: number; z: number } { return this.clearSpot(x, z, radii); }

  /** Swaps in the Keep's model for its tier. */
  private showKeep(): void {
    if (this.keepModel) this.scene.remove(this.keepModel);
    const kind = ['', 'tower_base', 'tower_A', 'castle'][this.tier];
    const model = this.normalized(buildingModel(this.map, kind), KEEP_SIZE[this.tier]);
    model.position.set(this.keepSpot.x, 0, this.keepSpot.z);
    this.scene.add(model);
    this.keepModel = model;
  }

  private raiseKeep(pad: Pad): void {
    this.tier++;
    this.showKeep();
    this.pops.push({ obj: this.keepModel!, t: 0, scale: this.keepModel!.scale.x });
    this.api.keepRaised(this.tier, this.keepSpot.x, this.keepSpot.z);
    for (const p of this.pads) this.drawLabel(p);
    const next = KEEP_TIERS[this.tier - 1];
    if (!next) { this.setPadActive(pad, false); return; }
    pad.title = `${next.title} ${TIER_NAMES[this.tier + 1]}`;
    pad.blurb = next.text;
    pad.woodCost = next.wood;
    pad.goldCost = next.gold;
    pad.woodPaid = pad.goldPaid = 0;
    pad.fill.scale.setScalar(0.001);
    pad.waitExit = true;
    this.drawLabel(pad);
    this.setPadActive(pad, true);
  }

  /** Adds a ring the game manages, such as a merchant's ware. */
  offer(spec: OfferSpec): Pad {
    const pad = this.createPad('offer', 'ballista', spec.x, spec.z, -1, spec.title, spec.wood, spec.gold, spec.radius ?? PAD_RADIUS, spec.blurb);
    pad.temp = true;
    pad.buy = spec.buy;
    pad.minTier = spec.minTier ?? 1;
    pad.waitExit = true;
    this.drawLabel(pad);
    this.pads.push(pad);
    return pad;
  }

  withdraw(pad: Pad): void {
    const i = this.pads.indexOf(pad);
    if (i < 0) return;
    this.pads.splice(i, 1);
    this.scene.remove(pad.group);
    pad.texture.dispose();
  }

  private isLocked(pad: Pad): boolean { return pad.minTier > this.tier; }

  /** Distance from a point to the edge of the nearest ring. */
  padClearance(x: number, z: number): number {
    let d = Infinity;
    for (const p of this.pads) d = Math.min(d, Math.hypot(p.x - x, p.z - z) - p.radius);
    return d;
  }

  /** Standing cottages or mines on one side of the wall. */
  targets(inside: boolean): Structure[] { return this.structures.filter((s) => insideCamp(s) === inside); }

  standing(s: Structure): boolean { return this.structures.includes(s); }

  hitStructure(s: Structure, amount: number): void {
    if (!this.structures.includes(s)) return;
    s.hp -= amount;
    s.bar.scale.x = Math.max(0.001, s.hp / s.maxHp);
    if (this.time >= s.nextFeel && s.hp > 0) {
      s.nextFeel = this.time + GATE_FEEL_GAP;
      this.api.feel('gateHit', s.x, s.z);
    }
    if (s.hp > 0) return;
    this.api.feel('ruin', s.x, s.z);
    this.removeStructure(s);
    this.clearPad(s.pad);
  }

  private removeStructure(s: Structure): void {
    this.structures.splice(this.structures.indexOf(s), 1);
    this.scene.remove(s.root);
    if (s.worker) this.scene.remove(s.worker.root);
    const i = this.obstacles.indexOf(s.obstacle);
    if (i >= 0) this.obstacles.splice(i, 1);
  }

  /** Repairs between waves and pays each cottage's rent; returns the gold paid. */
  waveCleared(): number {
    this.repairGates();
    let rent = 0;
    for (const s of this.structures) {
      s.hp = s.maxHp;
      s.bar.scale.x = 1;
      if (s.kind === 'house') rent += HOUSE_INCOME;
    }
    this.gold += rent;
    this.api.onResources();
    return rent;
  }

  /** Completes the cheapest unlocked upgrade for free; false if there is none. */
  freeUpgrade(): boolean {
    const open = this.pads.filter((p) => p.active && p.mode === 'upgrade' && !this.isLocked(p));
    if (open.length === 0) return false;
    open.sort((a, b) => a.woodCost + a.goldCost - b.woodCost - b.goldCost);
    this.upgrade(open[0]);
    return true;
  }

  get canFreeUpgrade(): boolean { return this.pads.some((p) => p.active && p.mode === 'upgrade' && !this.isLocked(p)); }

  /** Clones a model, resting on y=0, centred, with its longest side `length` long. */
  private normalized(name: string, length: number): THREE.Group {
    const src = this.assets.scene(name).clone();
    const box = new THREE.Box3().setFromObject(src);
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    src.position.set(-c.x, -box.min.y, -c.z);
    const scale = length / Math.max(size.x, size.y, size.z);
    const wrap = new THREE.Group();
    wrap.add(src);
    wrap.scale.setScalar(scale);
    wrap.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
    return wrap;
  }

  private tint(obj: THREE.Object3D, [r, g, b]: [number, number, number]): void {
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
      mat.color.multiply(new THREE.Color(r, g, b));
      mesh.material = mat;
    });
  }

  private tintStone(obj: THREE.Object3D): void {
    this.tint(obj, this.map.look.stone);
  }

  private createStack(): void {
    const holder = new THREE.Group();
    holder.position.set(0, 1.25 * CHAR_SCALE, -0.72 * CHAR_SCALE);
    holder.scale.setScalar(CHAR_SCALE);
    this.hero.add(holder);
    for (let i = 0; i < MAX_STACK; i++) {
      const log = this.logModel.clone();
      log.position.y = i * 0.17;
      log.rotation.y = (i % 2) * 0.22 - 0.11;
      log.visible = false;
      holder.add(log);
      this.stack.push(log);
    }
  }

  private createTrees(): void {
    const outer = GATE_SIDES.flatMap(([nx, nz]) => OUTER_TREES.map(([d, l]): [number, number] => [nx * d + nz * l, nz * d + nx * l]));
    [...this.map.trees, ...outer].forEach(([x, z], i) => {
      const kind = i % 2 === 0 ? 'A' : 'B';
      const obj = this.normalized(`tree_single_${kind}`, 4.2);
      const stump = this.normalized(`tree_single_${kind}_cut`, 1.6);
      if (this.map.look.foliage) this.tint(obj, this.map.look.foliage);
      obj.position.set(x, 0, z);
      stump.position.set(x, 0, z);
      stump.visible = false;
      this.scene.add(obj, stump);
      this.trees.push({ obj, stump, x, z, logs: LOGS_PER_TREE, regrow: 0, wobble: 0, base: obj.scale.x });
      this.obstacles.push({ x, z, r: 0.8 });
    });
  }

  private createPad(kind: Pad['kind'], tower: TowerKind, x: number, z: number, side: number, title: string, woodCost: number, goldCost: number, radius = PAD_RADIUS, blurb = ''): Pad {
    const group = new THREE.Group();
    group.position.set(x, 0.05, z);
    const flat = new THREE.Euler(-Math.PI / 2, 0, 0);
    const base = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), new THREE.MeshBasicMaterial({ color: 0x2b1a10, transparent: true, opacity: 0.45 }));
    base.rotation.copy(flat);
    const fill = new THREE.Mesh(new THREE.CircleGeometry(radius - 0.12, 40), new THREE.MeshBasicMaterial({ color: 0xf0c04a, transparent: true, opacity: 0.8 }));
    fill.rotation.copy(flat);
    fill.position.y = 0.01;
    fill.scale.setScalar(0.001);
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.12, radius + 0.06, 48), new THREE.MeshBasicMaterial({ color: BUILD_RING }));
    ring.rotation.copy(flat);
    ring.position.y = 0.02;

    const canvas = document.createElement('canvas');
    canvas.width = LABEL_W;
    canvas.height = LABEL_H;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true, fog: false, toneMapped: false }));
    label.scale.set(5.6, 5.6 * LABEL_H / LABEL_W, 1);
    label.position.y = 2.4;
    label.renderOrder = 10;
    group.add(base, fill, ring, label);
    this.scene.add(group);

    if (radius < PAD_RADIUS) { label.scale.set(4.6, 4.6 * LABEL_H / LABEL_W, 1); label.position.y = 2.1; }
    const pad: Pad = {
      kind, tower, job: null, minTier: 1, temp: false, buy: null, blurb, x, z, side, title, woodCost, goldCost, woodPaid: 0, goldPaid: 0, group, fill, ring, label, canvas, texture,
      active: true, tick: 0, radius, mode: 'build', level: 1, owner: null, base: { title, wood: woodCost, gold: goldCost, blurb }, waitExit: false,
    };
    this.drawLabel(pad);
    return pad;
  }

  private drawLabel(pad: Pad): void {
    const g = pad.canvas.getContext('2d')!;
    g.clearRect(0, 0, LABEL_W, LABEL_H);
    g.textAlign = 'center';
    g.lineWidth = 7;
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(30,18,10,0.9)';
    const text = (s: string, y: number, font: string, color: string) => {
      g.font = font;
      g.strokeText(s, LABEL_W / 2, y);
      g.fillStyle = color;
      g.fillText(s, LABEL_W / 2, y);
    };
    const locked = this.isLocked(pad);
    text(pad.title, 40, 'bold 36px Georgia, serif', locked ? '#cbbfae' : '#fbeed3');
    if (pad.blurb) text(pad.blurb, 82, 'bold 25px Georgia, serif', locked ? '#a9b8c2' : '#bfe6ff');
    const wood = pad.woodCost - pad.woodPaid;
    const gold = pad.goldCost - pad.goldPaid;
    const parts = [wood > 0 ? `${wood} wood` : '', gold > 0 ? `${gold} gold` : ''].filter(Boolean);
    const cost = locked ? `Needs Keep ${TIER_NAMES[pad.minTier]}` : parts.join('  ·  ') || 'Free';
    text(cost, pad.blurb ? 128 : 100, 'bold 32px Georgia, serif', locked ? '#c9b8a0' : '#ffd76a');
    pad.texture.needsUpdate = true;
    const ring = locked ? LOCKED_RING : pad.mode === 'upgrade' ? UPGRADE_RING : BUILD_RING;
    (pad.ring.material as THREE.MeshBasicMaterial).color.setHex(ring);
    // Locked rings recede so the ones you can buy stand out.
    const width = (pad.radius < PAD_RADIUS ? 4.6 : 5.6) * (locked ? 0.75 : 1);
    pad.label.scale.set(width, width * LABEL_H / LABEL_W, 1);
    pad.label.material.opacity = locked ? 0.55 : 1;
  }

  private setPadActive(pad: Pad, active: boolean): void {
    pad.active = active;
    pad.group.visible = active;
  }

  private clearPad(pad: Pad): void {
    pad.mode = 'build';
    pad.level = 1;
    pad.title = pad.base.title;
    pad.blurb = pad.base.blurb;
    pad.woodCost = pad.base.wood;
    pad.goldCost = pad.base.gold;
    if (pad.kind === 'gate') pad.minTier = 1;
    pad.woodPaid = pad.goldPaid = 0;
    pad.tick = 0;
    pad.fill.scale.setScalar(0.001);
    this.drawLabel(pad);
    this.setPadActive(pad, true);
  }

  reset(): void {
    this.wood = this.gold = 0;
    this.chopTimer = 0;
    for (const t of this.trees) {
      t.logs = LOGS_PER_TREE; t.regrow = 0; t.wobble = 0;
      t.obj.visible = true; t.obj.rotation.set(0, 0, 0); t.obj.scale.setScalar(t.base); t.stump.visible = false;
    }
    for (const c of this.coins) this.scene.remove(c.mesh);
    for (const f of this.flyers) this.scene.remove(f.obj);
    for (const t of this.towers) this.scene.remove(t.root);
    for (const g of this.gates) if (g) this.scene.remove(g.root);
    this.coins = []; this.flyers = []; this.pops = []; this.towers = [];
    this.gates = [null, null, null, null];
    this.obstacles.length = this.baseObstacles;
    for (const w of this.workers) this.scene.remove(w.actor.root, w.hut);
    for (const t of this.traps) this.scene.remove(t.root);
    this.workers = [];
    this.traps = [];
    for (const s of [...this.structures]) this.removeStructure(s);
    this.tier = 1;
    this.showKeep();
    for (const p of this.pads) {
      if (!p.temp) continue;
      this.scene.remove(p.group);
      p.texture.dispose();
    }
    this.pads = this.pads.filter((p) => !p.temp);
    for (const p of this.pads) this.clearPad(p);
    this.syncStack();
    this.api.onResources();
  }

  private syncStack(): void {
    const shown = Math.min(this.wood, MAX_STACK);
    this.stack.forEach((log, i) => { log.visible = i < shown; });
  }

  private fly(model: THREE.Object3D, from: THREE.Vector3, to: () => THREE.Vector3, dur: number): void {
    const obj = model.clone();
    obj.position.copy(from);
    this.scene.add(obj);
    this.flyers.push({ obj, from: from.clone(), to, t: 0, dur });
  }

  dropGold(x: number, z: number, count: number): void {
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(coinGeometry, coinMaterial);
      mesh.castShadow = true;
      mesh.position.set(x, 0.8, z);
      const a = Math.random() * Math.PI * 2;
      const v = 1.5 + Math.random() * 2.5;
      this.scene.add(mesh);
      this.coins.push({ mesh, vy: 6 + Math.random() * 2, vx: Math.cos(a) * v, vz: Math.sin(a) * v, value: 1 });
    }
  }

  /** Adds resources without the pickup effects. */
  grant(wood: number, gold: number): void {
    this.wood += wood;
    this.gold += gold;
    this.syncStack();
    this.api.onResources();
  }

  nearestTree(from: THREE.Vector3): { x: number; z: number } | null {
    return this.nearest(this.trees.filter((t) => t.regrow <= 0), from);
  }

  nearestGatePad(from: THREE.Vector3): { x: number; z: number } | null {
    return this.nearest(this.pads.filter((p) => p.active && p.kind === 'gate'), from);
  }

  private nearest<T extends { x: number; z: number }>(items: T[], from: THREE.Vector3): T | null {
    let best: T | null = null;
    let bestD = Infinity;
    for (const item of items) {
      const d = (item.x - from.x) ** 2 + (item.z - from.z) ** 2;
      if (d < bestD) { bestD = d; best = item; }
    }
    return best;
  }

  /** The standing barricade on a gate side, if any. */
  hasGate(side: number): boolean { return this.gates[side] !== null; }

  /** Damages a barricade; returns true if it is spiked and hurts its attacker. */
  hitGate(side: number, amount: number): boolean {
    const g = this.gates[side];
    if (!g) return false;
    g.hp -= amount;
    g.bar.scale.x = Math.max(0.001, g.hp / g.maxHp);
    if (this.time >= g.nextFeel && g.hp > 0) {
      g.nextFeel = this.time + GATE_FEEL_GAP;
      this.api.feel('gateHit', g.root.position.x, g.root.position.z);
    }
    if (g.hp <= 0) {
      this.api.feel('gateBreak', g.root.position.x, g.root.position.z);
      this.scene.remove(g.root);
      this.gates[side] = null;
      this.clearPad(g.pad);
      return false;
    }
    return g.level >= 3 || this.upgrades.thornWalls > 0;
  }

  /** Spiked gates mend fully between waves. */
  repairGates(): void {
    for (const g of this.gates) {
      if (!g || g.level < 3) continue;
      g.hp = g.maxHp;
      g.bar.scale.x = 1;
    }
  }

  /** Turns a pad into the ring that raises its structure to `level`. */
  private offerUpgrade(pad: Pad, key: UpgradeKey, level: number): void {
    const step = UPGRADES[key][level - 2];
    pad.mode = 'upgrade';
    pad.level = level;
    pad.title = step.title;
    pad.blurb = step.short;
    pad.woodCost = step.wood;
    pad.goldCost = step.gold;
    pad.woodPaid = pad.goldPaid = 0;
    pad.tick = 0;
    pad.fill.scale.setScalar(0.001);
    // Spiked gates need Keep II and tier III towers need Keep III.
    pad.minTier = level < 3 ? 1 : key === 'barricade' ? 2 : 3;
    pad.waitExit = true;
    this.drawLabel(pad);
    this.setPadActive(pad, true);
  }

  private upgrade(pad: Pad): void {
    const key: UpgradeKey = pad.owner ? pad.owner.kind : 'barricade';
    const step = UPGRADES[key][pad.level - 2];
    if (pad.owner) {
      pad.owner.level = pad.level;
      this.decorate(pad.owner);
      this.pops.push({ obj: pad.owner.root, t: 0.55, scale: 1 });
    } else {
      const g = this.gates[pad.side];
      if (!g) return;
      g.level = pad.level;
      g.maxHp = Math.round(GATE_HP * GATE_HP_SCALE[g.level - 1] * this.upgrades.gateHp);
      g.hp = g.maxHp;
      g.bar.scale.x = 1;
      this.styleGate(g);
      this.pops.push({ obj: g.root, t: 0.55, scale: 1 });
    }
    this.api.upgraded(step.text, pad.x, pad.z);
    if (pad.level < 3) this.offerUpgrade(pad, key, pad.level + 1);
    else this.setPadActive(pad, false);
  }

  /** Flags and a gold band show a tower's level. */
  private decorate(t: Tower): void {
    if (t.level === 2) t.root.add(this.makeFlag(1.2, t.height, 1.2));
    if (t.level === 3) {
      t.root.add(this.makeFlag(-1.2, t.height, -1.2));
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(1.75, 0.13, 8, 32).rotateX(Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xe6b84a, metalness: 0.7, roughness: 0.35 }),
      );
      band.position.y = t.height - 0.2;
      t.root.add(band);
    }
  }

  private makeFlag(x: number, y: number, z: number): THREE.Group {
    const flag = new THREE.Group();
    flag.position.set(x, y, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 6), new THREE.MeshStandardMaterial({ color: 0x5a4636 }));
    pole.position.y = 1.2;
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7), new THREE.MeshStandardMaterial({ color: 0xb3202c, side: THREE.DoubleSide }));
    cloth.position.set(0.55, 2.05, 0);
    pole.castShadow = cloth.castShadow = true;
    flag.add(pole, cloth);
    return flag;
  }

  /** Stone planks at level 2, iron spikes at level 3. */
  private styleGate(g: Gate): void {
    const plank = g.door.children[0] as THREE.Mesh;
    (plank.material as THREE.MeshStandardMaterial).color.setHex(0x8f8c86);
    if (g.level < 3) return;
    const iron = new THREE.MeshStandardMaterial({ color: 0x3f3a36, roughness: 0.4, metalness: 0.6 });
    const cone = new THREE.ConeGeometry(0.15, 0.8, 6).rotateX(Math.PI / 2);
    for (const face of [-1, 1]) {
      for (let i = 0; i < 7; i++) {
        for (const y of [1, 2.4]) {
          const spike = new THREE.Mesh(cone, iron);
          spike.position.set(-1.8 + i * 0.6, y, face * 0.5);
          spike.rotation.y = face > 0 ? 0 : Math.PI;
          spike.castShadow = true;
          g.door.add(spike);
        }
      }
    }
  }

  /** A clear spot beside a tower for its upgrade ring, inside the walls and away from other things. */
  private upgradeSpot(x: number, z: number): { x: number; z: number } {
    let best = { x: x - Math.sign(x || 1) * 3.6, z };
    let bestScore = -Infinity;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const cx = x + Math.cos(a) * 3.6;
      const cz = z + Math.sin(a) * 3.6;
      const outside = !insideCamp({ x, z });
      let score = !outside && Math.max(Math.abs(cx), Math.abs(cz)) > CAMP - 2.5 ? -100 : 0;
      if (outside && Math.max(Math.abs(cx), Math.abs(cz)) < CAMP + 2.5) score = -100;
      let clearance = Infinity;
      for (const o of this.obstacles) clearance = Math.min(clearance, Math.hypot(o.x - cx, o.z - cz) - o.r);
      for (const p of this.pads) if (p.x !== x || p.z !== z) clearance = Math.min(clearance, Math.hypot(p.x - cx, p.z - cz) - p.radius);
      score += Math.min(clearance, 4);
      if (score > bestScore) { bestScore = score; best = { x: cx, z: cz }; }
    }
    return best;
  }

  private build(pad: Pad): void {
    this.setPadActive(pad, false);
    this.api.feel('build', pad.x, pad.z);
    if (pad.kind === 'tower') this.buildTower(pad);
    else if (pad.kind === 'gate') this.buildGate(pad);
    else if (pad.kind === 'hut') this.buildHut(pad);
    else if (pad.kind === 'house' || pad.kind === 'mine') this.buildStructure(pad);
    else this.buildTrap(pad);
  }

  /** A cottage or the mine, with a health bar raiders can wear down. */
  private buildStructure(pad: Pad): void {
    const mine = pad.kind === 'mine';
    const root = new THREE.Group();
    root.position.set(pad.x, 0, pad.z);
    const model = this.normalized(buildingModel(this.map, mine ? 'mine' : 'home_A'), mine ? 5.2 : 4.6);
    model.rotation.y = Math.atan2(-pad.x, -pad.z);
    root.add(model);
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.36), new THREE.MeshBasicMaterial({ color: 0x24140b, fog: false, toneMapped: false }));
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 0.22), new THREE.MeshBasicMaterial({ color: 0x8fd14f, fog: false, toneMapped: false }));
    bar.geometry.translate(1.7, 0, 0);
    bar.position.set(-1.7, 0, 0.01);
    const hud = new THREE.Group();
    hud.position.y = mine ? 5.6 : 5.2;
    hud.rotation.x = -0.74;
    hud.add(bg, bar);
    root.add(hud);
    this.scene.add(root);
    this.pops.push({ obj: root, t: 0, scale: 1 });
    const obstacle = { x: pad.x, z: pad.z, r: 1.9 };
    this.obstacles.push(obstacle);
    let worker: Actor | null = null;
    if (mine) {
      worker = new Actor(this.assets, 'Rogue', 0.95);
      const a = Math.atan2(-pad.x, -pad.z);
      worker.root.position.set(pad.x + Math.sin(a) * 2.8, 0, pad.z + Math.cos(a) * 2.8);
      worker.root.rotation.y = a + Math.PI;
      worker.play('Interact');
      this.scene.add(worker.root);
    }
    const hp = mine ? MINE_HP : HOUSE_HP;
    this.structures.push({ kind: mine ? 'mine' : 'house', x: pad.x, z: pad.z, r: 1.9, hp, maxHp: hp, root, bar, pad, nextFeel: 0, worker, obstacle, tick: MINE_TICK });
  }

  private updateStructures(dt: number): void {
    for (const s of this.structures) {
      if (s.kind !== 'mine' || !s.worker) continue;
      s.worker.update(dt);
      s.tick -= dt;
      if (s.tick > 0) continue;
      s.tick = MINE_TICK;
      this.gold += MINE_YIELD;
      this.api.onResources();
      this.api.feel('mined', s.x, s.z, MINE_YIELD);
    }
  }

  /** The clearest spot inside the walls on rings of the given radii around a point. */
  private clearSpot(cx: number, cz: number, radii: number[]): { x: number; z: number } {
    let best = { x: cx, z: cz };
    let bestScore = -Infinity;
    for (const r of radii) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        if (Math.max(Math.abs(x), Math.abs(z)) > CAMP - 3) continue;
        let clearance = Math.hypot(x, z - 2) - 2.5; // keep clear of the hero's start
        for (const o of this.obstacles) clearance = Math.min(clearance, Math.hypot(o.x - x, o.z - z) - o.r);
        for (const p of this.pads) clearance = Math.min(clearance, Math.hypot(p.x - x, p.z - z) - p.radius);
        // Stay off the lanes from the gates to the centre.
        if (Math.min(Math.abs(x), Math.abs(z)) < 3) clearance -= 3;
        if (clearance > bestScore) { bestScore = clearance; best = { x, z }; }
      }
    }
    return best;
  }

  private buildHut(pad: Pad): void {
    const hut = this.normalized('tent', 3.2);
    hut.position.set(pad.x, 0, pad.z);
    this.scene.add(hut);
    this.obstacles.push({ x: pad.x, z: pad.z, r: 1.3 });
    this.pops.push({ obj: hut, t: 0, scale: hut.scale.x });
    const job = pad.job ?? 'woodcutter';
    const actor = new Actor(this.assets, job === 'woodcutter' ? 'Barbarian' : 'Rogue_Hooded', 0.95);
    actor.root.position.set(pad.x, 0, pad.z + 2);
    actor.play('Idle_A');
    this.scene.add(actor.root);
    this.workers.push({ job, actor, home: { x: pad.x, z: pad.z + 2 }, carry: 0, timer: 0, tree: null, hut });
  }

  private buildTrap(pad: Pad): void {
    const root = new THREE.Group();
    root.position.set(pad.x, 0, pad.z);
    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(TRAP_RADIUS, 24).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 }),
    );
    plate.position.y = 0.04;
    plate.receiveShadow = true;
    const cones: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 26; i++) {
      const a = i * 2.4;
      const r = Math.sqrt((i + 0.5) / 26) * (TRAP_RADIUS - 0.3);
      cones.push(new THREE.ConeGeometry(0.13, 0.6, 5).translate(Math.cos(a) * r, 0.3, Math.sin(a) * r));
    }
    const spikes = new THREE.Mesh(mergeGeometries(cones)!, new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 0.8 }));
    spikes.castShadow = true;
    root.add(plate, spikes);
    this.scene.add(root);
    this.pops.push({ obj: root, t: 0, scale: 1 });
    this.traps.push({ x: pad.x, z: pad.z, timer: 0, root });
  }

  /** Takes one log from a tree, felling it when empty. */
  private chopLog(tree: Tree): void {
    tree.logs--;
    tree.wobble = 0.22;
    if (tree.logs > 0) return;
    tree.regrow = TREE_REGROW;
    this.api.feel('fell', tree.x, tree.z);
    tree.obj.visible = false;
    tree.obj.rotation.z = 0;
    tree.stump.visible = true;
  }

  private updateWorkers(dt: number): void {
    for (const w of this.workers) {
      const p = w.actor.root.position;
      let goal: { x: number; z: number } | null = null;
      let anim = 'Idle_A';
      if (w.job === 'woodcutter') {
        if (w.carry >= WORKER_LOAD || (w.carry > 0 && !w.tree)) {
          goal = w.home;
          if (Math.hypot(p.x - w.home.x, p.z - w.home.z) < 1.2) {
            this.wood += w.carry;
            this.syncStack();
            this.api.onResources();
            this.api.feel('deliver', p.x, p.z, w.carry);
            w.carry = 0;
            goal = null;
          }
        } else {
          if (!w.tree || w.tree.regrow > 0) {
            w.tree = this.nearest(this.trees.filter((t) => t.regrow <= 0 && insideCamp(t)), p);
          }
          if (w.tree) {
            if (Math.hypot(p.x - w.tree.x, p.z - w.tree.z) < 2.4) {
              anim = 'Interact';
              w.actor.root.rotation.y = Math.atan2(w.tree.x - p.x, w.tree.z - p.z);
              w.timer -= dt;
              if (w.timer <= 0) {
                w.timer = WORKER_CHOP;
                this.chopLog(w.tree);
                this.api.feel('workerChop', w.tree.x, w.tree.z);
                w.carry++;
                if (w.tree.logs <= 0) w.tree = null;
              }
            } else {
              goal = w.tree;
            }
          } else if (Math.hypot(p.x - w.home.x, p.z - w.home.z) > 1.2) {
            goal = w.home;
          }
        }
      } else {
        const coin = this.nearest(this.coins.filter((c) => c.vy === 0 && insideCamp(c.mesh.position)).map((c) => ({ x: c.mesh.position.x, z: c.mesh.position.z, c })), p);
        if (coin) {
          goal = coin;
          if (Math.hypot(p.x - coin.x, p.z - coin.z) < 1) {
            this.gold += coin.c.value;
            this.api.feel('coin', coin.x, coin.z);
            this.scene.remove(coin.c.mesh);
            this.coins.splice(this.coins.indexOf(coin.c), 1);
            this.api.onResources();
          }
        } else if (Math.hypot(p.x - w.home.x, p.z - w.home.z) > 1.2) {
          goal = w.home;
        }
      }
      if (goal) {
        const dx = goal.x - p.x, dz = goal.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.05) {
          const step = Math.min(d, WORKER_SPEED * dt);
          p.x += (dx / d) * step;
          p.z += (dz / d) * step;
          w.actor.root.rotation.y = Math.atan2(dx, dz);
          for (const o of this.obstacles) {
            const ox = p.x - o.x, oz = p.z - o.z;
            const min = o.r + 0.45;
            const od = Math.hypot(ox, oz);
            if (od < min && od > 1e-4) { p.x = o.x + (ox / od) * min; p.z = o.z + (oz / od) * min; }
          }
          anim = 'Walking_A';
        }
      }
      w.actor.play(anim);
      w.actor.update(dt);
    }
  }

  private updateTraps(dt: number): void {
    for (const t of this.traps) {
      t.timer -= dt;
      if (t.timer > 0) continue;
      t.timer = TRAP_TICK;
      this.api.trap(t.x, t.z, TRAP_RADIUS);
    }
  }

  private buildTower(pad: Pad): void {
    const root = new THREE.Group();
    root.position.set(pad.x, 0, pad.z);
    const body = this.normalized('tower-square', 4.4);
    this.tintStone(body);
    const height = new THREE.Box3().setFromObject(body).getSize(new THREE.Vector3()).y;
    const head = pad.tower === 'beacon' ? this.createFlame() : this.normalized(pad.tower === 'ballista' ? 'siege-ballista' : 'siege-catapult', 2.8);
    head.position.y = height;
    root.add(body, head);
    this.scene.add(root);
    if (pad.tower === 'beacon') root.add(this.createBrazier(height));
    const tower: Tower = { pad, kind: pad.tower, head, root, cooldown: 0, top: new THREE.Vector3(pad.x, height + 0.8, pad.z), level: 1, pulses: 0, shots: 0, height };
    this.towers.push(tower);
    const spot = this.upgradeSpot(pad.x, pad.z);
    const ring = this.createPad('upgrade', pad.tower, spot.x, spot.z, -1, '', 0, 0, UPGRADE_RADIUS);
    ring.owner = tower;
    ring.temp = true;
    this.pads.push(ring);
    this.offerUpgrade(ring, pad.tower, 2);
    this.obstacles.push({ x: pad.x, z: pad.z, r: 1.9 });
    this.pops.push({ obj: root, t: 0, scale: 1 });
  }

  private createBrazier(height: number): THREE.Group {
    const iron = new THREE.MeshStandardMaterial({ color: 0x3f3a36, roughness: 0.5, metalness: 0.5 });
    const group = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 0.7, 10), iron);
    stem.position.y = height + 0.3;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.42, 0.55, 12), iron);
    bowl.position.y = height + 0.85;
    stem.castShadow = bowl.castShadow = true;
    group.add(stem, bowl);
    return group;
  }

  private createFlame(): THREE.Group {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 1.5, 2.4), toneMapped: false });
    const flame = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72, 0), material);
    flame.scale.set(1, 1.5, 1);
    flame.position.y = 1.7;
    group.add(flame);
    return group;
  }

  private buildGate(pad: Pad): void {
    const [nx, nz] = GATE_SIDES[pad.side];
    const root = new THREE.Group();
    root.position.set(nx * CAMP, 0, nz * CAMP);
    const model = this.normalized('wall-narrow-gate', 7);
    this.tintStone(model);
    // The kit's gate spans Z, so the north and south openings need a quarter turn.
    model.rotation.y = nz !== 0 ? Math.PI / 2 : 0;
    root.add(model);
    const door = this.createDoor(nz !== 0);
    root.add(door);

    const bg = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.42), new THREE.MeshBasicMaterial({ color: 0x24140b, fog: false, toneMapped: false }));
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 0.26), new THREE.MeshBasicMaterial({ color: 0x8fd14f, fog: false, toneMapped: false }));
    bar.geometry.translate(2.4, 0, 0);
    bar.position.set(-2.4, 0, 0.01);
    const hud = new THREE.Group();
    hud.position.y = 6.2;
    hud.rotation.x = -0.74;
    hud.add(bg, bar);
    root.add(hud);

    this.scene.add(root);
    const hp = Math.round(GATE_HP * this.upgrades.gateHp);
    this.gates[pad.side] = { hp, maxHp: hp, level: 1, root, bar, door, pad, nextFeel: 0, cooldown: 0 };
    this.pops.push({ obj: root, t: 0, scale: 1 });
    this.offerUpgrade(pad, 'barricade', 2);
  }

  /** Plank door that fills the arch of the gate model. */
  private createDoor(spansX: boolean): THREE.Group {
    const door = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x7a4e2a, roughness: 0.9 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x3f3a36, roughness: 0.5, metalness: 0.4 });
    const add = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
      const part = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      part.position.set(x, y, z);
      part.castShadow = true;
      door.add(part);
    };
    for (let i = 0; i < 6; i++) add(0.62, 3.6 - (i % 2) * 0.25, 0.3, -1.75 + i * 0.7, 1.8, 0, wood);
    for (const y of [0.9, 2.7]) add(4.3, 0.28, 0.42, 0, y, 0, iron);
    if (!spansX) door.rotation.y = Math.PI / 2;
    return door;
  }

  private updateTrees(dt: number, hero: THREE.Vector3): boolean {
    let target: Tree | null = null;
    let best = CHOP_RANGE * CHOP_RANGE;
    for (const t of this.trees) {
      if (t.regrow > 0) {
        t.regrow -= dt;
        if (t.regrow <= 0) {
          t.logs = LOGS_PER_TREE;
          t.obj.visible = true;
          t.stump.visible = false;
          this.pops.push({ obj: t.obj, t: 0, scale: t.base });
        }
        continue;
      }
      if (t.wobble > 0) {
        t.wobble = Math.max(0, t.wobble - dt);
        t.obj.rotation.z = Math.sin(t.wobble * 45) * t.wobble * 0.45;
      }
      const d = (t.x - hero.x) ** 2 + (t.z - hero.z) ** 2;
      if (d < best) { best = d; target = t; }
    }
    this.chopTimer -= dt;
    if (!target) return false;
    if (this.chopTimer <= 0) {
      this.chopTimer = this.upgrades.chopInterval;
      this.api.feel('chop', target.x, target.z);
      this.wood++;
      this.syncStack();
      this.api.onResources();
      this.fly(this.logModel, new THREE.Vector3(target.x, 1.6, target.z), () => this.hero.position.clone().setY(2.2), 0.22);
      this.chopLog(target);
    }
    return true;
  }

  private updateCoins(dt: number, hero: THREE.Vector3): void {
    for (let i = this.coins.length - 1; i >= 0; i--) {
      const c = this.coins[i];
      const p = c.mesh.position;
      if (p.y > 0.42 || c.vy > 0) {
        c.vy -= 22 * dt;
        p.x += c.vx * dt; p.y += c.vy * dt; p.z += c.vz * dt;
        if (p.y < 0.42) { p.y = 0.42; c.vy = 0; }
      }
      c.mesh.rotation.x = Math.PI / 2;
      c.mesh.rotation.z = this.time * 5 + i;
      const dx = hero.x - p.x, dz = hero.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d < this.upgrades.magnet && c.vy === 0) {
        const speed = 22 * (1 - d / (this.upgrades.magnet + 1)) + 7;
        p.x += (dx / d) * speed * dt;
        p.z += (dz / d) * speed * dt;
      }
      if (d < 1.1) {
        this.gold += c.value;
        this.api.feel('coin', p.x, p.z);
        this.scene.remove(c.mesh);
        this.coins.splice(i, 1);
        this.api.onResources();
      }
    }
  }

  private updatePads(dt: number, hero: THREE.Vector3): void {
    for (const pad of this.pads) {
      if (!pad.active) continue;
      const near = (pad.x - hero.x) ** 2 + (pad.z - hero.z) ** 2 < pad.radius * pad.radius;
      if (!near) { pad.waitExit = false; continue; }
      if (pad.waitExit || this.isLocked(pad)) continue;
      pad.tick -= dt;
      if (pad.tick > 0) continue;
      // Big costs pay faster, so no ring takes much longer than FILL_TIME to fill.
      pad.tick = Math.min(PAY_INTERVAL, FILL_TIME / (pad.woodCost + pad.goldCost));
      const dest = () => new THREE.Vector3(pad.x, 0.5, pad.z);
      let paid = false;
      if (pad.woodPaid < pad.woodCost && this.wood > 0) {
        this.wood--; pad.woodPaid++; paid = true;
        this.syncStack();
        this.fly(this.logModel, hero.clone().setY(2.2), dest, 0.2);
      } else if (pad.woodPaid >= pad.woodCost && pad.goldPaid < pad.goldCost && this.gold > 0) {
        this.gold--; pad.goldPaid++; paid = true;
      }
      if (!paid) continue;
      const total = pad.woodCost + pad.goldCost;
      pad.fill.scale.setScalar(Math.max(0.001, (pad.woodPaid + pad.goldPaid) / total));
      this.drawLabel(pad);
      this.api.onResources();
      this.api.feel('pay', pad.x, pad.z, (pad.woodPaid + pad.goldPaid) / total);
      if (pad.woodPaid >= pad.woodCost && pad.goldPaid >= pad.goldCost) this.complete(pad);
    }
  }

  private complete(pad: Pad): void {
    if (pad.kind === 'keep') { this.api.feel('build', pad.x, pad.z); this.raiseKeep(pad); return; }
    if (pad.kind !== 'offer') { if (pad.mode === 'build') this.build(pad); else this.upgrade(pad); return; }
    this.api.feel('bought', pad.x, pad.z);
    const next = pad.buy?.();
    if (!next) { this.withdraw(pad); return; }
    Object.assign(pad, { title: next.title, blurb: next.blurb, woodCost: next.wood, goldCost: next.gold, minTier: next.minTier ?? 1, woodPaid: 0, goldPaid: 0, waitExit: true });
    pad.fill.scale.setScalar(0.001);
    this.drawLabel(pad);
  }

  /** With the Gate Archers boon, every barricade shoots at foes approaching it. */
  private updateGates(dt: number): void {
    if (this.upgrades.gateShots <= 0) return;
    this.gates.forEach((g, side) => {
      if (!g) return;
      g.cooldown -= dt;
      if (g.cooldown > 0) return;
      const [nx, nz] = GATE_SIDES[side];
      const from = new THREE.Vector3(nx * CAMP, 5.5, nz * CAMP);
      const target = this.api.nearest(from, 12);
      if (!target) return;
      g.cooldown = 1 / this.upgrades.gateShots;
      this.api.fire(from, target, 2 + this.upgrades.towerDamage, 1);
    });
  }

  private updateTowers(dt: number): void {
    const speed = this.upgrades.towerInterval / BASE_TOWER_INTERVAL;
    const bonus = this.upgrades.towerDamage;
    for (const t of this.towers) {
      t.cooldown -= dt;
      const base = TOWERS[t.kind];
      const spec = { ...base, range: base.range * this.upgrades.towerRange, damage: base.damage + bonus };
      const lv = t.level;
      if (t.kind === 'beacon') {
        t.head.rotation.y += dt * 1.6;
        t.head.scale.setScalar(1 + Math.sin(this.time * 6) * 0.1 + (lv - 1) * 0.15);
        if (t.cooldown <= 0) {
          t.cooldown = spec.interval * speed;
          t.pulses++;
          const freeze = lv >= 3 && t.pulses % 3 === 0;
          this.api.aura(t.top.x, t.top.z, spec.range + (lv >= 2 ? 2 : 0), spec.damage, lv >= 2 ? 0.4 : 0.55, freeze);
        }
        continue;
      }
      const range = spec.range + (t.kind === 'ballista' && lv >= 3 ? 5 * this.upgrades.towerRange : 0);
      const target = this.api.nearest(t.top, range);
      if (!target) continue;
      t.head.rotation.y = Math.atan2(target.x - t.top.x, target.z - t.top.z) + HEAD_FACING[t.kind];
      if (t.cooldown > 0) continue;
      if (t.kind === 'ballista') {
        t.cooldown = spec.interval * speed * (lv >= 2 ? 0.8 : 1);
        t.shots++;
        const chain = this.upgrades.towerChain > 0 && t.shots % this.upgrades.towerChain === 0;
        this.api.fire(t.top, target, Math.round((spec.damage + (lv >= 2 ? 1 : 0)) * this.upgrades.towerDamageMul), lv >= 3 ? 2 : 1, chain);
      } else {
        t.cooldown = spec.interval * speed;
        this.api.lob(t.top, target, lv >= 2 ? 4.8 : 3.6, lv >= 3);
      }
    }
  }

  private updateAnimations(dt: number): void {
    for (let i = this.flyers.length - 1; i >= 0; i--) {
      const f = this.flyers[i];
      f.t += dt / f.dur;
      const k = Math.min(1, f.t);
      f.obj.position.lerpVectors(f.from, f.to(), k);
      f.obj.position.y += Math.sin(k * Math.PI) * 1.8;
      f.obj.rotation.y += dt * 9;
      if (k >= 1) { this.scene.remove(f.obj); this.flyers.splice(i, 1); }
    }
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.t = Math.min(1, p.t + dt / 0.45);
      const u = p.t - 1;
      const back = 1 + 2.7 * u * u * u + 1.7 * u * u; // ease-out-back
      p.obj.scale.setScalar(Math.max(0.001, back * p.scale));
      if (p.t >= 1) this.pops.splice(i, 1);
    }
  }

  /** Returns true while the hero is chopping a tree. */
  update(dt: number, hero: THREE.Vector3): boolean {
    this.time += dt;
    const chopping = this.updateTrees(dt, hero);
    this.updateCoins(dt, hero);
    this.updatePads(dt, hero);
    this.updateTowers(dt);
    this.updateGates(dt);
    this.updateWorkers(dt);
    this.updateTraps(dt);
    this.updateStructures(dt);
    this.updateAnimations(dt);
    return chopping;
  }

  snapshot(): EconomySnapshot {
    const base = this.pads.filter((p) => !p.temp);
    const built: Array<[number, number]> = [];
    base.forEach((pad, i) => {
      if (pad.kind === 'keep' || pad.kind === 'offer') return;
      if (pad.kind === 'gate') {
        const g = this.gates[pad.side];
        if (g) built.push([i, g.level]);
      } else if (pad.kind === 'tower') {
        const t = this.towers.find((tower) => tower.pad === pad);
        if (t) built.push([i, t.level]);
      } else if (!pad.active) {
        built.push([i, 1]);
      }
    });
    return { wood: this.wood, gold: this.gold, tier: this.tier, built };
  }

  /** Rebuilds a snapshot on a freshly reset economy. */
  restore(s: EconomySnapshot): void {
    const base = this.pads.filter((p) => !p.temp);
    const keep = base.find((p) => p.kind === 'keep');
    while (keep && this.tier < Math.min(3, s.tier)) this.raiseKeep(keep);
    for (const [i, level] of s.built) {
      const pad = base[i];
      if (!pad || !pad.active) continue;
      this.build(pad);
      for (let l = 2; l <= level; l++) {
        const ring = pad.kind === 'gate' ? pad : this.pads.find((p) => p.owner?.pad === pad);
        if (ring && ring.active && ring.mode === 'upgrade') this.upgrade(ring);
      }
    }
    this.wood = Math.max(0, s.wood);
    this.gold = Math.max(0, s.gold);
    this.syncStack();
    this.api.onResources();
  }

  /** Completes an offer ring as if paid for, used when resuming a run. */
  forceComplete(pad: Pad): void {
    if (this.pads.includes(pad)) this.complete(pad);
  }

  get stats() {
    return { tier: this.tier, structures: this.structures.length, wood: this.wood, gold: this.gold, workers: this.workers.length, traps: this.traps.length, towers: this.towers.length, gates: this.gates.filter(Boolean).length, coins: this.coins.length };
  }
}
