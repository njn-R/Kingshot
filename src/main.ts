import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Assets } from './assets';
import { Game } from './game';
import type { Input } from './hero';
import { Hud } from './hud';
import { createMenu } from './menu';
import { MAPS, mapModels, type MapDef } from './maps';
import { save } from './save';
import { Sfx } from './sfx';

const el = (id: string) => document.getElementById(id)!;

const PIXEL_CAPS = [matchMedia('(pointer: coarse)').matches ? 1.5 : 2, 1.25, 1];
const QUALITY_SAMPLE = 2.5;
const MIN_FPS = 34;

function createInput(): () => Input {
  const keys = new Set<string>();
  addEventListener('keydown', (e) => keys.add(e.code));
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  const stick = el('stick');
  const nub = el('nub');
  const RADIUS = 44;
  let pointer: number | null = null;
  let ox = 0, oy = 0, sx = 0, sz = 0;

  addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    pointer = e.pointerId; ox = e.clientX; oy = e.clientY; sx = sz = 0;
    stick.style.left = `${ox}px`; stick.style.top = `${oy}px`; stick.style.display = 'block';
    nub.style.transform = '';
  });
  addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer) return;
    const dx = e.clientX - ox, dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    const k = len > RADIUS ? RADIUS / len : 1;
    nub.style.transform = `translate(${dx * k}px,${dy * k}px)`;
    sx = len > 6 ? (dx * k) / RADIUS : 0;
    sz = len > 6 ? (dy * k) / RADIUS : 0;
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null; sx = sz = 0; stick.style.display = 'none';
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);

  return () => {
    let x = sx, z = sz;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) z -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) z += 1;
    const len = Math.hypot(x, z);
    return len > 1 ? { x: x / len, z: z / len } : { x, z };
  };
}

async function start(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  document.body.prepend(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 220);
  const assets = new Assets();
  await assets.load();

  const sfx = new Sfx();
  const hud = new Hud();
  let game: Game;
  let tier = 0; // 0 is full quality; slow devices step down to 2.
  const renderPass = new RenderPass(new THREE.Scene(), camera);

  const showLoading = (shown: boolean) => { el('load').style.display = shown ? 'flex' : 'none'; };

  /** Builds a map's world, replacing the current one. */
  const loadMap = async (map: MapDef): Promise<void> => {
    if (game?.map === map) return;
    showLoading(true);
    await new Promise((r) => setTimeout(r, 30)); // lets the loading text paint first
    await assets.ensure(mapModels(map));
    game?.dispose();
    game = new Game(assets, camera, hud, sfx, map);
    renderPass.scene = game.scene;
    game.setShadows(tier < 2);
    if (import.meta.env.DEV) Object.assign(window, { game });
    showLoading(false);
  };

  const setPaused = (paused: boolean) => {
    if (paused && !game.running) return;
    game.paused = paused;
    el('paused').style.display = paused ? 'flex' : 'none';
  };

  const showMenu = () => {
    setPaused(false);
    document.body.dataset.screen = 'menu';
    game.toMenu();
    refreshMenu();
  };
  const play = async (map: MapDef) => {
    await loadMap(map);
    save.setLastMap(map.id);
    document.body.dataset.screen = 'play';
    game.start();
  };

  await loadMap(MAPS.find((m) => m.id === save.data.lastMap) ?? MAPS[0]);
  document.body.dataset.screen = 'menu';
  const refreshMenu = createMenu(sfx, (map) => { void play(map); });
  const b = hud.buttons;
  b.again.addEventListener('click', () => game.start());
  b.endless.addEventListener('click', () => game.pressOn());
  b.callNow.addEventListener('click', () => game.callWave());
  b.pause.addEventListener('click', () => setPaused(true));
  b.abilities[0].addEventListener('click', () => game.useAbility(0));
  b.abilities[1].addEventListener('click', () => game.useAbility(1));
  b.resume.addEventListener('click', () => setPaused(false));
  b.abandon.addEventListener('click', showMenu);
  addEventListener('keydown', (e) => { if ((e.code === 'Escape' || e.code === 'KeyP') && !e.repeat) setPaused(!game.paused); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
  b.toMenu.addEventListener('click', showMenu);

  const mute = b.mute;
  const showMute = () => {
    mute.textContent = sfx.muted ? 'Sound off' : 'Sound on';
    mute.setAttribute('aria-pressed', String(sfx.muted));
  };
  const toggleMute = () => { sfx.toggleMute(); showMute(); };
  showMute();
  mute.addEventListener('click', toggleMute);
  addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.repeat) toggleMute(); });
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => sfx.unlock());

  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.16, 0.5, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = innerWidth, h = innerHeight;
    const dpr = Math.min(devicePixelRatio, PIXEL_CAPS[tier]);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  const readInput = createInput();
  let last = performance.now();

  let sampleTime = 0, sampleFrames = 0;
  const watchFrameRate = (seconds: number) => {
    if (seconds > 0.25 || document.hidden) { sampleTime = sampleFrames = 0; return; }
    sampleTime += seconds;
    sampleFrames++;
    if (sampleTime < QUALITY_SAMPLE) return;
    if (sampleFrames / sampleTime < MIN_FPS && tier < 2) {
      tier++;
      bloom.enabled = false;
      game.setShadows(tier < 2);
      resize();
    }
    sampleTime = sampleFrames = 0;
  };

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const seconds = (now - last) / 1000;
    watchFrameRate(seconds);
    game.update(Math.min(seconds, 0.05), readInput());
    last = now;
    composer.render();
  });
}

start().catch((err) => {
  console.error(err);
  el('load').textContent = 'The game failed to load. Please refresh.';
});
