import * as THREE from 'three';
import type { Assets } from './assets';
import { buildingModel, type MapDef, type MapLook } from './maps';

/** Half-width of the walled camp, and half-width of the opening in each wall. */
export const CAMP = 28;
export const GATE = 4;
export const GATE_SIDES: ReadonlyArray<readonly [number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

export interface Obstacle { x: number; z: number; r: number }

/** How far the hero may roam from the camp's centre. */
export const WORLD_LIMIT = 68;
/** Width of the clear meadow ring between the walls and the forest. */
export const MEADOW = 11;
const WALL_HALF = 0.9;

/**
 * Keeps a walker out of the curtain wall. It may pass a gate opening only when
 * `canPass(side)` allows; `prev` is where it stood before moving, which says which side it is on.
 */
export function collideWalls(p: THREE.Vector3, prev: { x: number; z: number }, radius: number, canPass: (side: number) => boolean): void {
  GATE_SIDES.forEach(([nx, nz], side) => {
    const d = p.x * nx + p.z * nz;
    if (Math.abs(d - CAMP) > WALL_HALF + radius) return;
    const along = Math.abs(p.x * nz + p.z * nx);
    if (along > CAMP + WALL_HALF) return;
    if (along < GATE - 0.9 - radius && canPass(side)) return;
    const before = prev.x * nx + prev.z * nz;
    const target = before < CAMP ? CAMP - WALL_HALF - radius : CAMP + WALL_HALF + radius;
    p.x += nx * (target - d);
    p.z += nz * (target - d);
  });
}

export const insideCamp = (p: { x: number; z: number }): boolean => Math.max(Math.abs(p.x), Math.abs(p.z)) < CAMP;

interface Placement { matrix: THREE.Matrix4; tint?: THREE.Color }

/** Collects static props per model, then draws each model as instanced meshes. */
class Batcher {
  private items = new Map<string, Placement[]>();
  constructor(private assets: Assets, private group: THREE.Group) {}

  /** Places a model with its footprint centred on x/z and its base at y. */
  add(name: string, x: number, z: number, rotY: number, scale: number, y = 0, tint?: THREE.Color): void {
    const box = new THREE.Box3().setFromObject(this.assets.scene(name));
    const c = box.getCenter(new THREE.Vector3());
    const matrix = new THREE.Matrix4()
      .makeTranslation(x, y, z)
      .multiply(new THREE.Matrix4().makeRotationY(rotY))
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z));
    const list = this.items.get(name) ?? [];
    list.push({ matrix, tint });
    this.items.set(name, list);
  }

  /** Draws everything added so far. With `materials`, each mesh gets its own copy that the caller can fade. */
  build(materials?: THREE.Material[]): void {
    const m = new THREE.Matrix4();
    for (const [name, list] of this.items) {
      this.assets.scene(name).traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        let material = mesh.material;
        if (materials) {
          material = (Array.isArray(material) ? material[0] : material).clone();
          materials.push(material);
        }
        const inst = new THREE.InstancedMesh(mesh.geometry, material, list.length);
        list.forEach((p, i) => {
          inst.setMatrixAt(i, m.multiplyMatrices(p.matrix, mesh.matrixWorld));
          if (p.tint) inst.setColorAt(i, p.tint);
        });
        inst.castShadow = true;
        inst.receiveShadow = true;
        inst.frustumCulled = false;
        this.group.add(inst);
      });
    }
    this.items.clear();
  }
}

/** The walls on the camera's side of the hero fade so they don't hide the fight. */
export interface WallFade { update(hero: { x: number; z: number }, dt: number): void }

function modelSize(assets: Assets, name: string): THREE.Vector3 {
  return new THREE.Box3().setFromObject(assets.scene(name)).getSize(new THREE.Vector3());
}

/** Deterministic random so the map is the same every run. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const GROUND_SIZE = 260;
const FADED_WALL = 0.28;
const toColor = ([r, g, b]: [number, number, number]) => new THREE.Color(r, g, b);

/** A single painted ground: a mottled base with roads from each open gate to the square. */
function buildGround(rand: () => number, map: MapDef): THREE.Mesh {
  const px = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = px;
  const g = canvas.getContext('2d')!;
  const toPx = (w: number) => (w / GROUND_SIZE + 0.5) * px;
  const unit = px / GROUND_SIZE;

  const look = map.look;
  g.fillStyle = look.ground;
  g.fillRect(0, 0, px, px);
  const blotch = (x: number, y: number, r: number, color: string) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };
  const greens = look.blotches;
  for (let i = 0; i < 1800; i++) {
    blotch(rand() * px, rand() * px, 14 + rand() * 80, greens[Math.floor(rand() * greens.length)]);
  }

  // Roads are stamped as overlapping soft dabs, so their edges wander naturally.
  const dirt = (x: number, z: number, r: number) => {
    const jitter = r * 0.3;
    blotch(toPx(x + (rand() - 0.5) * jitter), toPx(z + (rand() - 0.5) * jitter), r * unit * (0.85 + rand() * 0.3), look.road);
  };
  for (const side of map.openSides) {
    const [nx, nz] = GATE_SIDES[side];
    for (let t = 8; t <= 80; t += 0.5) {
      const wobble = Math.sin(t * 0.17) * 0.8;
      dirt(nx * t + nz * wobble, nz * t + nx * wobble, 3.4);
    }
  }
  for (let i = 0; i < 700; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * 8;
    dirt(Math.cos(a) * r, Math.sin(a) * r, 3);
  }
  // Fine speckle stops the ground looking airbrushed up close.
  for (let i = 0; i < 26000; i++) {
    g.fillStyle = rand() > 0.5 ? look.specks[0] : look.specks[1];
    g.fillRect(rand() * px, rand() * px, 1 + rand() * 2.5, 1 + rand() * 2.5);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 1 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildWorld(scene: THREE.Scene, assets: Assets, map: MapDef): { obstacles: Obstacle[]; walls: WallFade } {
  const group = new THREE.Group();
  scene.add(group);
  const b = new Batcher(assets, group);
  const rand = rng(7);
  const obstacles: Obstacle[] = [];

  const STONE = toColor(map.look.stone);
  const foliage = map.look.foliage ? toColor(map.look.foliage) : undefined;
  scene.add(buildGround(rand, map));

  // Curtain wall: four sides, each with a central gate flanked by towers.
  const wallSize = modelSize(assets, 'wall');
  const SEG = 4;
  const wallScale = SEG / Math.max(wallSize.x, wallSize.z);
  const alongX = wallSize.x >= wallSize.z;
  const sides: Array<[number, number, boolean]> = [[0, -CAMP, true], [0, CAMP, true], [-CAMP, 0, false], [CAMP, 0, false]];
  const wallMats: THREE.Material[][] = [];
  sides.forEach(([sx, sz, horizontal], side) => {
    if (!map.openSides.includes(side)) {
      // A walled-up gate: nothing comes through on this side.
      for (const sign of [-1, 1]) {
        b.add('wall', horizontal ? sign * SEG / 2 : sx, horizontal ? sz : sign * SEG / 2, horizontal === alongX ? 0 : Math.PI / 2, wallScale, 0, STONE);
      }
    }
    for (let t = GATE + SEG / 2; t < CAMP; t += SEG) {
      for (const sign of [-1, 1]) {
        const x = horizontal ? sign * t : sx;
        const z = horizontal ? sz : sign * t;
        b.add('wall', x, z, horizontal === alongX ? 0 : Math.PI / 2, wallScale, 0, STONE);
      }
    }
    for (const sign of [-1, 1]) {
      b.add('tower-square', horizontal ? sign * GATE : sx, horizontal ? sz : sign * GATE, 0, wallScale, 0, STONE);
    }
    // The corner towers go with the north and south walls, the ones that can block the view.
    if (horizontal) for (const x of [-CAMP, CAMP]) b.add('tower-square', x, sz, 0, wallScale, 0, STONE);
    wallMats[side] = [];
    b.build(wallMats[side]);
  });
  const opacity = [1, 1, 1, 1];
  const walls: WallFade = {
    update(hero, dt) {
      const inX = Math.abs(hero.x) < CAMP + 3;
      // South wall hides a hero just inside it; north wall hides one just outside it.
      const want = [inX && hero.z < -CAMP + 1 && hero.z > -CAMP - 11, inX && hero.z > CAMP - 11 && hero.z < CAMP + 1];
      want.forEach((faded, side) => {
        const target = faded ? FADED_WALL : 1;
        const o = opacity[side] = THREE.MathUtils.damp(opacity[side], target, 8, dt);
        for (const m of wallMats[side]) {
          const see = o < 0.99;
          if (m.transparent !== see) { m.transparent = see; m.needsUpdate = true; }
          m.opacity = o;
          m.depthWrite = !see;
        }
      });
    },
  };

  // The hamlet. Lanes from each gate to the centre stay open.
  const BUILDING_BOOST = 1.3;
  for (const [kind, x, z, rot, s] of map.buildings) {
    const name = buildingModel(map, kind);
    b.add(name, x, z, rot, s * BUILDING_BOOST);
    const size = modelSize(assets, name);
    obstacles.push({ x, z, r: Math.max(size.x, size.z) * s * BUILDING_BOOST * 0.42 });
  }
  for (const [name, x, z, rot, s, r] of map.props) {
    b.add(name, x, z, rot, s);
    obstacles.push({ x, z, r });
  }

  // Forest outside the walls, leaving the four approach roads clear.
  const trees = map.forest;
  for (let n = 0; n < 420; n++) {
    const x = (rand() - 0.5) * 150;
    const z = (rand() - 0.5) * 150;
    const outside = Math.max(Math.abs(x), Math.abs(z)) > CAMP + MEADOW;
    const onRoad = map.openSides.some((side) => {
      const [nx, nz] = GATE_SIDES[side];
      return x * nx + z * nz > 0 && Math.abs(x * nz + z * nx) < 9;
    });
    if (!outside || onRoad) continue;
    const name = trees[Math.floor(rand() * trees.length)];
    const scale = 2.4 + rand() * 1.0;
    b.add(name, x, z, rand() * Math.PI * 2, scale, 0, name.startsWith('rock') ? undefined : foliage);
    obstacles.push({ x, z, r: (name.includes('large') ? 1.1 : 0.55) * scale });
  }

  b.build();
  return { obstacles, walls };
}

/** Golden-hour light; the sun's shadow box follows `target`. */
export function buildLighting(scene: THREE.Scene, look: MapLook): THREE.DirectionalLight {
  scene.background = new THREE.Color(look.sky);
  scene.fog = new THREE.Fog(look.sky, 52, 105);
  scene.add(new THREE.HemisphereLight(look.hemi[0], look.hemi[1], look.hemi[2]));

  const sun = new THREE.DirectionalLight(look.sun[0], look.sun[1]);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const c = sun.shadow.camera;
  c.left = -45; c.right = 45; c.top = 45; c.bottom = -45; c.near = 1; c.far = 140;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  scene.add(sun, sun.target);
  return sun;
}

/** Drifting snow or rising embers around the camera. Returns its per-frame update. */
export function buildWeather(scene: THREE.Scene, kind: MapLook['weather']): (dt: number, focus: THREE.Vector3) => void {
  if (kind === 'none') return () => {};
  const COUNT = 260, WIDE = 80, HIGH = 26;
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) positions.set([(Math.random() - 0.5) * WIDE, Math.random() * HIGH, (Math.random() - 0.5) * WIDE], i * 3);
  const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const dot = document.createElement('canvas');
  dot.width = dot.height = 32;
  const g = dot.getContext('2d')!;
  const glow = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, 32, 32);
  const snow = kind === 'snow';
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({
    map: new THREE.CanvasTexture(dot), color: snow ? 0xffffff : 0xff9a4a, size: snow ? 0.55 : 0.4, transparent: true, depthWrite: false, fog: false,
    blending: snow ? THREE.NormalBlending : THREE.AdditiveBlending,
  }));
  points.frustumCulled = false;
  scene.add(points);
  const fall = snow ? -3.2 : 2.6;
  let time = 0;
  return (dt, focus) => {
    time += dt;
    points.position.x = focus.x;
    points.position.z = focus.z;
    for (let i = 0; i < COUNT; i++) {
      let y = positions[i * 3 + 1] + fall * dt * (0.7 + (i % 5) * 0.12);
      if (y < 0) y += HIGH; else if (y > HIGH) y -= HIGH;
      positions[i * 3 + 1] = y;
      positions[i * 3] += Math.sin(time * 0.8 + i) * dt * 0.8;
    }
    geometry.getAttribute('position').needsUpdate = true;
  };
}
