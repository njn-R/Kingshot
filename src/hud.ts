import * as THREE from 'three';
import type { WaveOption } from './data';
import { ready, type Enemy } from './horde';
import type { Site } from './wilds';

const el = (id: string) => document.getElementById(id)!;
const ARROW_SECTORS = 16;
const ARROW_MARGIN = 30;
const BANNER_TIME = 1.5;

export interface HudState {
  hp: number; maxHp: number; xp: number; xpNext: number; level: number;
  wave: number; waves: number; endless: boolean; streakMul: number; kills: number; wood: number; gold: number;
}

/** One of three things to pick from, on the parchment cards. */
export interface Choice { title: string; text: string; pick(): void }

/** Everything the game draws in HTML on top of the canvas. */
export class Hud {
  /** Buttons the shell wires up itself. */
  readonly buttons = {
    again: el('again'), endless: el('endless'), callNow: el('callNow'), pause: el('pause'), resume: el('resume'),
    abandon: el('abandon'), toMenu: el('toMenu'), mute: el('mute'), abilities: [el('volley'), el('bash')] as [HTMLElement, HTMLElement],
  };
  private edgeArrows: Array<{ root: HTMLElement; arrow: HTMLElement; count: HTMLElement }> = [];
  private siteArrows: Array<{ root: HTMLElement; arrow: HTMLElement }> = [];
  private projected = new THREE.Vector3();
  private bannerTimer = 0;
  private shownCooldown = [-1, -1];
  private shownRest = -1;

  constructor() {
    const arrows = el('arrows');
    arrows.replaceChildren();
    for (let i = 0; i < 12; i++) {
      const root = document.createElement('div');
      root.className = 'edge';
      const arrow = document.createElement('i');
      const count = document.createElement('b');
      root.append(arrow, count);
      arrows.append(root);
      this.edgeArrows.push({ root, arrow, count });
    }
    for (let i = 0; i < 6; i++) {
      const root = document.createElement('div');
      root.className = 'edge site';
      const arrow = document.createElement('i');
      root.append(arrow);
      arrows.append(root);
      this.siteArrows.push({ root, arrow });
    }
  }

  reset(): void {
    this.hideCards();
    this.boss(null);
    this.hurt(0);
    this.hideOver();
    this.showNext(false);
    for (const a of this.edgeArrows) a.root.style.display = 'none';
    for (const a of this.siteArrows) a.root.style.display = 'none';
    this.shownCooldown = [-1, -1];
    this.shownRest = -1;
  }

  refresh(s: HudState): void {
    el('hp').style.width = `${Math.max(0, s.hp / s.maxHp) * 100}%`;
    el('xp').style.width = `${(s.xp / s.xpNext) * 100}%`;
    el('level').textContent = `Lv ${s.level}`;
    el('wave').textContent = s.wave === 0 ? '' : s.endless ? `Wave ${s.wave} · Endless` : `Wave ${s.wave}/${s.waves}`;
    el('streak').textContent = s.streakMul >= 1.1 ? `×${s.streakMul.toFixed(1)}` : '';
    el('kills').textContent = `Slain ${s.kills}`;
    el('wood').textContent = `${s.wood}`;
    el('gold').textContent = `${s.gold}`;
  }

  /** Pops a resource counter to show it changed. */
  bump(which: 'wood' | 'gold'): void {
    el(which).animate([{ transform: 'scale(1.22)' }, { transform: 'scale(1)' }], { duration: 130 });
  }

  banner(text: string): void {
    const b = el('banner');
    b.textContent = text;
    b.style.opacity = '1';
    this.bannerTimer = BANNER_TIME;
  }

  update(dt: number): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) el('banner').style.opacity = '0';
    }
  }

  boss(name: string | null): void {
    el('boss').style.display = name ? 'block' : 'none';
    if (name) { el('bossFill').style.width = '100%'; el('bossName').textContent = name; }
  }

  bossHealth(fraction: number): void { el('bossFill').style.width = `${fraction * 100}%`; }

  /** The red vignette: a flash when hurt, a pulse when low. */
  hurt(opacity: number): void { el('hurt').style.opacity = `${opacity}`; }

  /** The next-wave panel; banners move down out of its way while it shows. */
  showNext(shown: boolean): void {
    el('next').style.display = shown ? 'flex' : 'none';
    document.body.classList.toggle('resting', shown);
    if (shown) this.shownRest = -1;
  }

  /** Lays out the two ways the next wave can go (none before the first wave). */
  options(options: readonly WaveOption[], choice: number, onPick: (index: number) => void): void {
    const box = el('nextOpts');
    box.replaceChildren();
    options.forEach((o, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      const head = document.createElement('strong');
      head.textContent = i === 0 ? 'Hold steady' : 'Raise the stakes';
      const twist = document.createElement('span');
      twist.textContent = o.horde > 1 ? `${o.mod.title}: ${o.mod.text.toLowerCase()}, bigger horde` : `${o.mod.title}: ${o.mod.text.toLowerCase()}`;
      const pay = document.createElement('em');
      pay.textContent = o.boon ? 'Reward: a boon' : `Reward: ${o.gold} gold`;
      b.append(head, twist, pay);
      b.addEventListener('click', () => onPick(i));
      box.append(b);
    });
    this.markChoice(choice);
  }

  markChoice(choice: number): void {
    [...el('nextOpts').children].forEach((b, i) => b.classList.toggle('chosen', i === choice));
  }

  /** Countdown text, redrawn only when the second changes. Returns false if nothing changed. */
  countdown(seconds: number, title: string, call: string): boolean {
    if (seconds === this.shownRest) return false;
    this.shownRest = seconds;
    el('nextTitle').textContent = title;
    el('callNow').textContent = call;
    return true;
  }

  /** Pauses play to offer a choice of three. */
  present(heading: string, choices: readonly Choice[], onPick: (index: number) => void): void {
    const cards = el('cards');
    cards.replaceChildren();
    const row = document.createElement('div');
    row.className = 'row';
    choices.forEach((c, i) => {
      const b = document.createElement('button');
      const title = document.createElement('strong');
      title.textContent = c.title;
      const text = document.createElement('span');
      text.textContent = c.text;
      b.append(title, text);
      b.addEventListener('click', () => onPick(i));
      row.append(b);
    });
    const h = document.createElement('h2');
    h.textContent = heading;
    cards.append(h, row);
    cards.style.display = 'flex';
  }

  hideCards(): void { el('cards').style.display = 'none'; }

  /** Names the two ability buttons for the current class. */
  abilityLabels(labels: ReadonlyArray<{ title: string; key: string }>): void {
    this.buttons.abilities.forEach((b, i) => {
      const { title, key } = labels[i];
      b.replaceChildren();
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      b.append(title, kbd);
      b.setAttribute('aria-label', `${title}, key ${key}`);
    });
  }

  /** Draws a cooldown sweep; `fraction` 0 means ready. */
  abilityCooldown(index: number, fraction: number): void {
    const shown = Math.round(fraction * 100) / 100;
    if (shown === this.shownCooldown[index]) return;
    this.shownCooldown[index] = shown;
    const button = this.buttons.abilities[index];
    button.style.setProperty('--cd', String(shown));
    button.classList.toggle('ready', shown === 0);
  }

  /** Arrows at the screen edge point to foes out of view, with how many lie that way, plus markers for camps and chests. */
  edges(camera: THREE.Camera, pool: readonly Enemy[], sites: readonly Site[], running: boolean): void {
    const w = innerWidth, h = innerHeight;
    const place = (a: { root: HTMLElement; arrow: HTMLElement }, angle: number) => {
      const cx = Math.cos(angle), cy = Math.sin(angle);
      const k = 1 / Math.max(Math.abs(cx), Math.abs(cy));
      const x = THREE.MathUtils.clamp((cx * k * 0.5 + 0.5) * w, ARROW_MARGIN, w - ARROW_MARGIN);
      const y = THREE.MathUtils.clamp((-cy * k * 0.5 + 0.5) * h, ARROW_MARGIN + 40, h - ARROW_MARGIN);
      a.root.style.display = 'block';
      a.root.style.transform = `translate(${x}px,${y}px)`;
      a.arrow.style.transform = `rotate(${-angle}rad)`;
    };
    /** Screen angle of a world point if it is off screen, else null. */
    const offscreen = (x: number, z: number): number | null => {
      const v = this.projected.set(x, 1, z).project(camera);
      const behind = v.z > 1;
      if (!behind && Math.abs(v.x) < 0.98 && Math.abs(v.y) < 0.98) return null;
      return behind ? Math.atan2(-v.y, -v.x) : Math.atan2(v.y, v.x);
    };

    const sectors = new Map<number, { count: number; boss: boolean }>();
    if (running) {
      for (const e of pool) {
        if (!ready(e)) continue;
        const angle = offscreen(e.actor.root.position.x, e.actor.root.position.z);
        if (angle === null) continue;
        const sector = ((Math.round((angle / (Math.PI * 2)) * ARROW_SECTORS) % ARROW_SECTORS) + ARROW_SECTORS) % ARROW_SECTORS;
        const s = sectors.get(sector) ?? { count: 0, boss: false };
        s.count++;
        s.boss ||= e.kind === 'Boss';
        sectors.set(sector, s);
      }
    }
    let i = 0;
    for (const [sector, s] of sectors) {
      if (i >= this.edgeArrows.length) break;
      const a = this.edgeArrows[i++];
      place(a, (sector / ARROW_SECTORS) * Math.PI * 2);
      a.root.classList.toggle('boss', s.boss);
      a.count.textContent = s.count > 1 ? String(s.count) : '';
    }
    for (; i < this.edgeArrows.length; i++) this.edgeArrows[i].root.style.display = 'none';

    let j = 0;
    if (running) {
      for (const s of sites) {
        if (j >= this.siteArrows.length) break;
        const angle = offscreen(s.x, s.z);
        if (angle === null) continue;
        const a = this.siteArrows[j++];
        place(a, angle);
        a.root.classList.toggle('camp', s.kind === 'camp');
      }
    }
    for (; j < this.siteArrows.length; j++) this.siteArrows[j].root.style.display = 'none';
  }

  /** The end-of-run screen. */
  over(title: string, score: string, endlessOffered: boolean): void {
    el('title').textContent = title;
    el('score').textContent = score;
    el('endless').style.display = endlessOffered ? '' : 'none';
    el('over').style.display = 'flex';
  }

  hideOver(): void {
    el('over').style.display = 'none';
    el('endless').style.display = 'none';
  }
}
