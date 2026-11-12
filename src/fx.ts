import * as THREE from 'three';

const MAX_PARTICLES = 400;
const MAX_NUMBERS = 40;
const MAX_RINGS = 6;
const GRAVITY = 24;
const NUMBER_LIFE = 0.7;
const RING_LIFE = 0.5;
const SHAKE_DECAY = 2.4;
const SHAKE_DISTANCE = 1.5;

interface Particle { life: number; maxLife: number; size: number; pos: THREE.Vector3; vel: THREE.Vector3; spin: number }
interface FloatingNumber { sprite: THREE.Sprite; life: number; size: number; drift: number }
interface Ring { mesh: THREE.Mesh; life: number; radius: number }

const textures = new Map<string, THREE.CanvasTexture>();

/** Number sprites reuse one texture per text and colour. */
function numberTexture(text: string, color: string): THREE.CanvasTexture {
  const key = `${text}|${color}`;
  const cached = textures.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const g = canvas.getContext('2d')!;
  g.font = 'bold 46px Georgia, serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(30,18,10,0.95)';
  g.strokeText(text, 64, 33);
  g.fillStyle = color;
  g.fillText(text, 64, 33);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, texture);
  return texture;
}

/** Short-lived visual effects. Everything is pooled so a big fight allocates almost nothing. */
export class Fx {
  private particles: Particle[] = [];
  private nextParticle = 0;
  private mesh: THREE.InstancedMesh;
  private numbers: FloatingNumber[] = [];
  private nextNumber = 0;
  private rings: Ring[] = [];
  private nextRing = 0;
  private trauma = 0;
  private time = 0;
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private shakeScale = this.reducedMotion ? 0 : 1;

  constructor(scene: THREE.Scene) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PARTICLES);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, this.color.set(0xffffff));
    scene.add(this.mesh);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ life: 0, maxLife: 1, size: 0, pos: new THREE.Vector3(), vel: new THREE.Vector3(), spin: 0 });
    }
    for (let i = 0; i < MAX_NUMBERS; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, fog: false, toneMapped: false }));
      sprite.visible = false;
      sprite.renderOrder = 20;
      scene.add(sprite);
      this.numbers.push({ sprite, life: 0, size: 1, drift: 0 });
    }
    const ringGeometry = new THREE.RingGeometry(0.84, 1, 48).rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_RINGS; i++) {
      const mesh = new THREE.Mesh(ringGeometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }));
      mesh.visible = false;
      mesh.position.y = 0.12;
      scene.add(mesh);
      this.rings.push({ mesh, life: 0, radius: 1 });
    }
    this.clear();
  }

  burst(x: number, y: number, z: number, color: number, count: number, speed: number, size: number): void {
    this.color.set(color);
    for (let i = 0; i < count; i++) {
      const index = this.nextParticle;
      this.nextParticle = (index + 1) % MAX_PARTICLES;
      const p = this.particles[index];
      const angle = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.6);
      p.pos.set(x, y, z);
      p.vel.set(Math.cos(angle) * v, speed * (0.5 + Math.random() * 0.7), Math.sin(angle) * v);
      p.maxLife = p.life = 0.35 + Math.random() * 0.3;
      p.size = size * (0.6 + Math.random() * 0.6);
      p.spin = Math.random() * 6;
      this.mesh.setColorAt(index, this.color);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  number(x: number, y: number, z: number, text: string, color: string, size = 1): void {
    const n = this.numbers[this.nextNumber];
    this.nextNumber = (this.nextNumber + 1) % MAX_NUMBERS;
    n.sprite.material.map = numberTexture(text, color);
    n.sprite.material.needsUpdate = true;
    n.sprite.position.set(x + (Math.random() - 0.5) * 0.7, y, z);
    n.sprite.visible = true;
    n.life = NUMBER_LIFE;
    n.size = size;
    n.drift = (Math.random() - 0.5) * 1.4;
  }

  ring(x: number, z: number, color: number, radius: number): void {
    const r = this.rings[this.nextRing];
    this.nextRing = (this.nextRing + 1) % MAX_RINGS;
    (r.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    r.mesh.position.x = x;
    r.mesh.position.z = z;
    r.mesh.visible = true;
    r.life = RING_LIFE;
    r.radius = radius;
  }

  /** Turns screen shake off, or on unless the system asks for reduced motion. */
  setShake(on: boolean): void { this.shakeScale = on && !this.reducedMotion ? 1 : 0; }

  /** Adds screen shake; 1 is the strongest. */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Moves a camera that has already been aimed. */
  applyShake(camera: THREE.Camera): void {
    if (this.trauma <= 0) return;
    const k = this.trauma * this.trauma * SHAKE_DISTANCE * this.shakeScale;
    const t = this.time;
    camera.position.x += Math.sin(t * 71) * Math.cos(t * 43) * k;
    camera.position.y += Math.sin(t * 59 + 1.7) * k * 0.6;
    camera.position.z += Math.cos(t * 67 + 0.6) * Math.sin(t * 37) * k;
  }

  clear(): void {
    this.trauma = 0;
    for (const p of this.particles) p.life = 0;
    for (const n of this.numbers) { n.life = 0; n.sprite.visible = false; }
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < MAX_PARTICLES; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private updateParticles(dt: number): void {
    let changed = false;
    this.particles.forEach((p, i) => {
      if (p.life <= 0) return;
      changed = true;
      p.life -= dt;
      p.vel.y -= GRAVITY * dt;
      p.pos.addScaledVector(p.vel, dt);
      if (p.pos.y < 0.08) { p.pos.y = 0.08; p.vel.set(p.vel.x * 0.5, -p.vel.y * 0.3, p.vel.z * 0.5); }
      const d = this.dummy;
      d.position.copy(p.pos);
      d.rotation.set(p.life * p.spin * 3, p.life * p.spin * 5, 0);
      d.scale.setScalar(p.life > 0 ? p.size * Math.min(1, (p.life / p.maxLife) * 3) : 0);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    });
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private updateNumbers(dt: number): void {
    for (const n of this.numbers) {
      if (n.life <= 0) continue;
      n.life -= dt;
      if (n.life <= 0) { n.sprite.visible = false; continue; }
      const age = 1 - n.life / NUMBER_LIFE;
      n.sprite.position.y += dt * 3.2 * (1 - age);
      n.sprite.position.x += dt * n.drift;
      const pop = age < 0.18 ? 0.7 + (age / 0.18) * 0.6 : 1.3 - Math.min(0.3, (age - 0.18) * 1.5);
      n.sprite.scale.set(2.8 * n.size * pop, 1.4 * n.size * pop, 1);
      n.sprite.material.opacity = Math.min(1, (1 - age) * 3);
    }
  }

  private updateRings(dt: number): void {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) { r.mesh.visible = false; continue; }
      const age = 1 - r.life / RING_LIFE;
      r.mesh.scale.setScalar(r.radius * (1 - (1 - age) ** 3));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - age;
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * dt);
    this.updateParticles(dt);
    this.updateNumbers(dt);
    this.updateRings(dt);
  }
}
