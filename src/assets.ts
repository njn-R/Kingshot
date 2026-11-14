import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const HEX = ['tree_single_A_cut', 'tree_single_B_cut', 'tree_single_A', 'tree_single_B', 'trees_A_large', 'trees_B_large', 'rock_single_A',
  'rock_single_C', 'barrel', 'crate_A_big', 'tent', 'resource_lumber', 'trees_A_cut', 'trees_B_cut', 'trees_A_medium', 'rock_single_D',
  'crate_open', 'sack', 'wheelbarrow', 'resource_stone', 'building_bridge_A'];
const CASTLE = ['wall', 'tower-square', 'siege-ballista', 'siege-catapult', 'wall-narrow-gate', 'flag-pennant', 'siege-ram-demolished', 'siege-trebuchet-demolished'];
const CHARS = ['Knight', 'Barbarian', 'Rogue_Hooded', 'Rogue', 'Ranger', 'Mage', 'Skeleton_Minion', 'Skeleton_Rogue', 'Skeleton_Warrior', 'Skeleton_Mage'];
const ANIMS = ['Rig_Medium_General', 'Rig_Medium_MovementBasic'];
const PROPS = ['arrow_bow', 'crossbow_1handed', 'bow_withString', 'axe_2handed', 'crossbow_2handed', 'staff', 'dagger', 'sword_1handed', 'shield_round',
  'smokebomb', 'Skeleton_Crossbow', 'Skeleton_Shield_Large_A', 'Skeleton_Shield_Small_A', 'Skeleton_Blade', 'Skeleton_Axe', 'Skeleton_Staff', 'Skeleton_Arrow'];

export type Progress = (done: number, total: number) => void;

export class Assets {
  private scenes = new Map<string, THREE.Object3D>();
  clips = new Map<string, THREE.AnimationClip>();
  private loader = new GLTFLoader();

  constructor() {
    // Dozens of models share one palette texture; the cache fetches it once.
    THREE.Cache.enabled = true;
    // Models are shipped meshopt-compressed (see scripts/optimize-assets.mjs).
    this.loader.setMeshoptDecoder(MeshoptDecoder);
  }

  async load(onProgress?: Progress): Promise<void> {
    const loader = this.loader;
    const total = HEX.length + CASTLE.length + CHARS.length + PROPS.length + ANIMS.length;
    let done = 0;
    const get = async (key: string, url: string): Promise<GLTF> => {
      const gltf = await loader.loadAsync(url);
      this.scenes.set(key, gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      onProgress?.(++done, total);
      return gltf;
    };
    const anims = await Promise.all([
      ...HEX.map((n) => get(n, `models/hex/${n}.gltf`)),
      ...CASTLE.map((n) => get(n, `models/castle/${n}.glb`)),
      ...CHARS.map((n) => get(n, `models/chars/${n}.glb`)),
      ...PROPS.map((n) => get(n, `models/props/${n}.gltf`)),
      ...ANIMS.map((n) => get(n, `models/anim/${n}.glb`)),
    ]);
    for (const gltf of anims) for (const clip of gltf.animations) this.clips.set(clip.name, clip);
    this.reskinHero();
  }

  /** Loads the given hexagon-pack models, skipping any already loaded. */
  async ensure(names: string[]): Promise<void> {
    await Promise.all(names.filter((n) => !this.scenes.has(n)).map(async (n) => {
      const gltf = await this.loader.loadAsync(`models/hex/${n}.gltf`);
      gltf.scene.updateMatrixWorld(true);
      this.scenes.set(n, gltf.scene);
    }));
  }

  /** Repaints the stock knight's blue cloth in the Warden's crimson. */
  private reskinHero(): void {
    const done = new Set<THREE.Texture>();
    this.scene('Knight').traverse((o) => {
      const material = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      const map = material?.map;
      if (!map || done.has(map)) return;
      done.add(map);
      const image = map.image as CanvasImageSource & { width: number; height: number };
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const g = canvas.getContext('2d')!;
      g.drawImage(image, 0, 0);
      const pixels = g.getImageData(0, 0, canvas.width, canvas.height);
      const d = pixels.data;
      for (let i = 0; i < d.length; i += 4) {
        const [r, gr, b] = [d[i], d[i + 1], d[i + 2]];
        if (b > r * 1.18 && b > gr * 1.05) { d[i] = Math.min(255, b * 1.05); d[i + 1] = gr * 0.35; d[i + 2] = r * 0.45; }
      }
      g.putImageData(pixels, 0, 0);
      map.image = canvas;
      map.needsUpdate = true;
    });
  }

  scene(name: string): THREE.Object3D {
    const s = this.scenes.get(name);
    if (!s) throw new Error(`Unknown model: ${name}`);
    return s;
  }
}
