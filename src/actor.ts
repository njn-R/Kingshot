import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Assets } from './assets';

const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
const mergedTemplates = new Map<string, THREE.Object3D>();
const PUNCH_TIME = 0.13;
const PUNCH_AMOUNT = 0.22;

/** Builds a copy of a character whose body parts are one mesh per material, so it costs one draw call. */
function mergedTemplate(assets: Assets, model: string): THREE.Object3D {
  const cached = mergedTemplates.get(model);
  if (cached) return cached;
  const template = cloneSkinned(assets.scene(model));
  const byMaterial = new Map<THREE.Material, THREE.SkinnedMesh[]>();
  template.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const mat = mesh.material as THREE.Material;
    byMaterial.set(mat, [...(byMaterial.get(mat) ?? []), mesh]);
  });
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const geometry = mergeGeometries(meshes.map((m) => m.geometry));
    if (!geometry) continue; // Incompatible attributes: keep the separate parts.
    const merged = new THREE.SkinnedMesh(geometry, material);
    merged.name = `${model}_merged`;
    merged.bind(meshes[0].skeleton, meshes[0].bindMatrix);
    meshes[0].parent!.add(merged);
    for (const m of meshes) m.parent!.remove(m);
  }
  mergedTemplates.set(model, template);
  return template;
}

/** An animated, skinned character cloned from a loaded model. */
export class Actor {
  readonly root: THREE.Object3D;
  private mixer: THREE.AnimationMixer;
  private current?: THREE.AnimationAction;
  private currentName = '';
  /** `material` is the model's own; `current` is what shows when not flashing (it may glow). */
  private meshes: Array<{ mesh: THREE.SkinnedMesh; material: THREE.Material | THREE.Material[]; current: THREE.Material | THREE.Material[]; glow?: THREE.MeshStandardMaterial }> = [];
  private flashLeft = 0;
  private punchLeft = 0;

  constructor(private assets: Assets, model: string, private scale: number, merge = false) {
    this.root = cloneSkinned(merge ? mergedTemplate(assets, model) : assets.scene(model));
    this.root.scale.setScalar(scale);
    this.root.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        this.meshes.push({ mesh, material: mesh.material, current: mesh.material });
      }
    });
    this.mixer = new THREE.AnimationMixer(this.root);
  }

  play(name: string, once = false, fade = 0.15): void {
    if (name === this.currentName) return;
    const clip = this.assets.clips.get(name);
    if (!clip) throw new Error(`Unknown clip: ${name}`);
    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.fadeIn(fade).play();
    this.current?.fadeOut(fade);
    this.current = next;
    this.currentName = name;
  }

  flash(): void {
    this.flashLeft = 0.07;
    for (const m of this.meshes) m.mesh.material = flashMaterial;
  }

  /** Makes the character glow in a colour, or stops it with null. */
  setGlow(color: number | null): void {
    for (const m of this.meshes) {
      if (color === null || Array.isArray(m.material)) {
        m.current = m.material;
      } else {
        m.glow ??= (m.material as THREE.MeshStandardMaterial).clone();
        m.glow.emissive.setHex(color);
        m.glow.emissiveIntensity = 0.6;
        m.current = m.glow;
      }
      if (this.flashLeft <= 0) m.mesh.material = m.current;
    }
  }

  /** Briefly squashes the character, to sell a hit. */
  punch(): void {
    this.punchLeft = PUNCH_TIME;
  }

  /** Clears animation so a pooled actor can be reused. */
  reset(): void {
    this.mixer.stopAllAction();
    this.current = undefined;
    this.currentName = '';
    this.flashLeft = 0;
    this.punchLeft = 0;
    this.root.scale.setScalar(this.scale);
    for (const m of this.meshes) { m.current = m.material; m.mesh.material = m.material; }
  }

  update(dt: number): void {
    this.mixer.update(dt);
    if (this.flashLeft > 0) {
      this.flashLeft -= dt;
      if (this.flashLeft <= 0) for (const m of this.meshes) m.mesh.material = m.current;
    }
    if (this.punchLeft > 0) {
      this.punchLeft = Math.max(0, this.punchLeft - dt);
      const k = (this.punchLeft / PUNCH_TIME) * PUNCH_AMOUNT;
      this.root.scale.set(this.scale * (1 + k), this.scale * (1 - k), this.scale * (1 + k));
    }
  }
}
