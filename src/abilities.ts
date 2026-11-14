import * as THREE from 'three';
import type { Upgrades } from './data';
import type { Fx } from './fx';
import type { Horde } from './horde';
import type { Projectiles } from './projectiles';
import { rand } from './rng';
import type { Sfx } from './sfx';

export type AbilityId = 'volley' | 'bash' | 'rain' | 'dash' | 'whirlwind' | 'warcry' | 'fireball' | 'frostnova' | 'smoke' | 'fan';

/** What an ability may do to the world when used. The game provides it. */
export interface AbilityContext {
  hero: THREE.Vector3;
  /** The way the hero faces, as a rotation about Y. */
  facing: number;
  upgrades: Upgrades;
  horde: Horde;
  shots: Projectiles;
  fx: Fx;
  sfx: Sfx;
  /** One bolt's damage with the current weapon, times `mul`. */
  boltDamage(mul?: number): number;
  /** Move faster for a while. */
  boost(mul: number, seconds: number): void;
  invulnerable(seconds: number): void;
  /** Foes lose track of the hero. */
  stealth(seconds: number): void;
  /** Hit harder for a while. */
  empower(mul: number, seconds: number): void;
  /** Cleave everything around the hero repeatedly for a while. */
  whirl(seconds: number): void;
  banner(text: string): void;
}

export interface Ability { id: AbilityId; title: string; text: string; cooldown: number; use(ctx: AbilityContext): void }

const GOLD = 0xffd24a;
const DUST = 0xb9a584;
const VOLLEY_BOLTS = 18;
const BASH_RADIUS = 5.5;

/** The nearest foe within range, or a point ahead of the hero. */
function aimPoint(ctx: AbilityContext, range: number): THREE.Vector3 {
  const foe = ctx.horde.nearest(ctx.hero, range);
  if (foe) return foe.actor.root.position.clone();
  return new THREE.Vector3(ctx.hero.x + Math.sin(ctx.facing) * 8, 0, ctx.hero.z + Math.cos(ctx.facing) * 8);
}

export const ABILITIES: Record<AbilityId, Ability> = {
  volley: {
    id: 'volley', title: 'Volley', text: 'A ring of bolts in every direction', cooldown: 10,
    use(ctx) {
      const p = ctx.hero;
      const from = p.clone().setY(1.6);
      for (let i = 0; i < VOLLEY_BOLTS; i++) {
        const a = (i / VOLLEY_BOLTS) * Math.PI * 2;
        ctx.shots.fire(from, new THREE.Vector3(p.x + Math.cos(a) * 10, 1.5, p.z + Math.sin(a) * 10), ctx.boltDamage() + 1, 1, 1);
      }
      ctx.sfx.shoot();
      ctx.fx.ring(p.x, p.z, GOLD, 5);
      ctx.fx.shake(0.15);
    },
  },
  bash: {
    id: 'bash', title: 'Bash', text: 'Shoves and stuns every foe around you', cooldown: 14,
    use(ctx) {
      const p = ctx.hero;
      ctx.horde.bash(p, BASH_RADIUS, 4.5, 0.9, 3);
      ctx.sfx.boulder();
      ctx.fx.ring(p.x, p.z, 0xffffff, BASH_RADIUS);
      ctx.fx.burst(p.x, 0.5, p.z, DUST, 26, 10, 0.26);
      ctx.fx.shake(0.35);
    },
  },
  rain: {
    id: 'rain', title: 'Arrow Rain', text: 'Arrows fall on the nearest pack of foes', cooldown: 12,
    use(ctx) {
      const t = aimPoint(ctx, 18);
      for (let i = 0; i < 16; i++) {
        const x = t.x + (rand() - 0.5) * 9, z = t.z + (rand() - 0.5) * 9;
        ctx.shots.fire(new THREE.Vector3(x, 9, z), new THREE.Vector3(x, 0, z), ctx.boltDamage(), 1, 0);
      }
      ctx.sfx.shoot();
      ctx.fx.ring(t.x, t.z, GOLD, 5);
    },
  },
  dash: {
    id: 'dash', title: 'Dash', text: 'A burst of speed; nothing can touch you for a moment', cooldown: 8,
    use(ctx) {
      ctx.boost(2.8, 0.55);
      ctx.invulnerable(0.7);
      ctx.fx.burst(ctx.hero.x, 0.6, ctx.hero.z, DUST, 14, 7, 0.2);
      ctx.sfx.beacon();
    },
  },
  whirlwind: {
    id: 'whirlwind', title: 'Whirlwind', text: 'Spin through the horde, cleaving for a few seconds', cooldown: 14,
    use(ctx) {
      ctx.whirl(2.5);
      ctx.sfx.boulder();
      ctx.fx.ring(ctx.hero.x, ctx.hero.z, 0xffe0b0, 4.5);
    },
  },
  warcry: {
    id: 'warcry', title: 'War Cry', text: 'Stuns foes nearby and makes your blows land harder', cooldown: 16,
    use(ctx) {
      const p = ctx.hero;
      ctx.horde.bash(p, 8, 0, 1.5, 1);
      ctx.empower(1.5, 6);
      ctx.sfx.horn(false);
      ctx.fx.ring(p.x, p.z, 0xff9a60, 8);
      ctx.fx.shake(0.3);
      ctx.banner('War cry: blows land harder');
    },
  },
  fireball: {
    id: 'fireball', title: 'Fireball', text: 'A blazing orb that bursts and leaves fire', cooldown: 9,
    use(ctx) {
      const p = ctx.hero;
      ctx.shots.fireball(p.clone().setY(1.6), aimPoint(ctx, 20), ctx.boltDamage(3), 4);
      ctx.sfx.cast();
      ctx.fx.burst(p.x, 1.6, p.z, 0xff8a30, 10, 5, 0.16);
    },
  },
  frostnova: {
    id: 'frostnova', title: 'Frost Nova', text: 'Freezes every foe around you solid', cooldown: 13,
    use(ctx) {
      const p = ctx.hero;
      ctx.horde.aura(p.x, p.z, 7, 2, 0.3, true);
      ctx.fx.ring(p.x, p.z, 0xffffff, 7);
      ctx.fx.burst(p.x, 1, p.z, 0xe8f8ff, 30, 9, 0.2);
      ctx.sfx.beacon();
    },
  },
  smoke: {
    id: 'smoke', title: 'Smoke Bomb', text: 'Vanish: foes lose you for three seconds', cooldown: 15,
    use(ctx) {
      const p = ctx.hero;
      ctx.stealth(3);
      ctx.fx.burst(p.x, 1, p.z, 0x8a8a8a, 44, 7, 0.34);
      ctx.sfx.gateHit();
      ctx.banner('Lost in the smoke');
    },
  },
  fan: {
    id: 'fan', title: 'Fan of Knives', text: 'A wide spread of knives ahead of you', cooldown: 7,
    use(ctx) {
      const p = ctx.hero;
      ctx.shots.fire(p.clone().setY(1.5), aimPoint(ctx, 14), ctx.boltDamage(1.2), 10, 1, false, 0.24);
      ctx.sfx.shoot();
      ctx.fx.burst(p.x, 1.4, p.z, GOLD, 8, 5, 0.12);
    },
  },
};
