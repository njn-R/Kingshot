import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Assets } from './assets';
import type { HeroClass } from './classes';
import type { Daily } from './daily';
import { Game, type RunSnapshot } from './game';
import { track } from './analytics';
import { Hud } from './hud';
import { InputController } from './input';
import { createMenu } from './menu';
import { MAPS, mapModels, type MapDef } from './maps';
import { classById } from './classes';
import { dailyFor } from './daily';
import { Music } from './music';
import { save } from './save';
import { settings, type Quality } from './settings';
import { mountSettingsPanel } from './settingsUi';
import { Sfx } from './sfx';

const el = (id: string) => document.getElementById(id)!;

const PIXEL_CAPS = [matchMedia('(pointer: coarse)').matches ? 1.5 : 2, 1.25, 1];
const QUALITY_SAMPLE = 2.5;
const MIN_FPS = 34;
/** A fixed quality setting pins the tier; auto starts at full and steps down on slow devices. */
const FORCED_TIER: Record<Quality, number | null> = { auto: null, high: 0, medium: 1, low: 2 };

async function start(): Promise<void> {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  document.body.prepend(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(35, 1, 1, 220);
  const assets = new Assets();
  const loadText = el('loadText');
  const loadBar = el('loadBar').firstElementChild as HTMLElement;
  await assets.load((done, total) => {
    loadText.textContent = `Raising the walls… ${done}/${total}`;
    loadBar.style.width = `${(done / total) * 100}%`;
  });

  const sfx = new Sfx();
  const music = new Music(() => sfx.context);
  const hud = new Hud();
  let game: Game;
  let autoTier = 0; // 0 is full quality; slow devices step down to 2.
  let tier = 0;
  const renderPass = new RenderPass(new THREE.Scene(), camera);

  const showLoading = (shown: boolean) => { el('load').style.display = shown ? 'flex' : 'none'; };

  /** Builds a map's world, replacing the current one. */
  const loadMap = async (map: MapDef): Promise<void> => {
    if (game?.map === map) return;
    showLoading(true);
    loadText.textContent = `Raising ${map.name}…`;
    loadBar.style.width = '100%';
    await new Promise((r) => setTimeout(r, 30)); // lets the loading text paint first
    await assets.ensure(mapModels(map));
    game?.dispose();
    game = new Game(assets, camera, hud, sfx, map);
    renderPass.scene = game.scene;
    game.setShadows(tier < 2);
    game.setShake(settings.data.shake);
    if (import.meta.env.DEV) Object.assign(window, { game });
    showLoading(false);
  };

  const setPaused = (paused: boolean) => {
    if (paused && !game.running) return;
    game.paused = paused;
    el('paused').style.display = paused ? 'flex' : 'none';
  };

  const showMenu = (abandon = false) => {
    if (abandon) save.setRun(null);
    setPaused(false);
    document.body.dataset.screen = 'menu';
    game.toMenu();
    refreshMenu();
  };
  /** The last run's class and daily, for "Defend again". */
  let lastRun: { cls: HeroClass; daily: Daily | null } = { cls: classById(save.data.lastClass), daily: null };
  const play = async (map: MapDef, cls: HeroClass, daily: Daily | null = null, snapshot: RunSnapshot | null = null) => {
    await loadMap(map);
    if (!daily) save.setLastMap(map.id);
    document.body.dataset.screen = 'play';
    lastRun = { cls, daily };
    game.start(cls, daily, snapshot);
  };

  await loadMap(MAPS.find((m) => m.id === save.data.lastMap) ?? MAPS[0]);
  document.body.dataset.screen = 'menu';
  const refreshMenu = createMenu(sfx, {
    play: (map, cls) => { save.setRun(null); void play(map, cls); },
    daily: (daily, cls) => { save.setRun(null); void play(daily.map, cls, daily); },
    resume: (run) => {
      const map = MAPS.find((m) => m.id === run.map)!;
      const today = dailyFor();
      const daily = run.daily === today.key ? today : run.daily ? { ...today, key: run.daily, seed: run.dailySeed, map } : null;
      void play(map, classById(run.cls), daily, run);
    },
  });
  const b = hud.buttons;
  b.again.addEventListener('click', () => game.start(lastRun.cls, lastRun.daily));
  b.endless.addEventListener('click', () => game.pressOn());
  b.callNow.addEventListener('click', () => game.callWave());
  b.pause.addEventListener('click', () => setPaused(true));
  b.abilities[0].addEventListener('click', () => game.useAbility(0));
  b.abilities[1].addEventListener('click', () => game.useAbility(1));
  b.resume.addEventListener('click', () => setPaused(false));
  b.abandon.addEventListener('click', () => { if (confirm('Abandon this run? It cannot be resumed.')) { track('run_abandon', { map: game.map.id }); showMenu(true); } });
  el('quitSave').addEventListener('click', () => showMenu());
  b.toMenu.addEventListener('click', () => showMenu());
  el('share').addEventListener('click', async () => {
    const text = game.shareText;
    const url = location.href.split('#')[0].split('?')[0];
    track('share');
    try {
      if (navigator.share) { await navigator.share({ title: 'Palisade', text, url }); return; }
      await navigator.clipboard.writeText(`${text} ${url}`);
      el('share').textContent = 'Copied!';
      setTimeout(() => { el('share').textContent = 'Share'; }, 1500);
    } catch { /* the player cancelled the share sheet */ }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });

  const mute = b.mute;
  const showMute = () => {
    mute.textContent = sfx.muted ? 'Sound off' : 'Sound on';
    mute.setAttribute('aria-pressed', String(sfx.muted));
  };
  const toggleMute = () => { sfx.toggleMute(); music.setMuted(sfx.muted); showMute(); };
  showMute();
  music.setMuted(sfx.muted);
  mute.addEventListener('click', toggleMute);
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => sfx.unlock());

  const input = new InputController((action) => {
    switch (action) {
      case 'ability1': game.useAbility(0); break;
      case 'ability2': game.useAbility(1); break;
      case 'call': game.callWave(); break;
      case 'pause': setPaused(!game.paused); break;
      case 'mute': toggleMute(); break;
      case 'pick1': game.pick(0); break;
      case 'pick2': game.pick(1); break;
      case 'pick3': game.pick(2); break;
      case 'option1': game.chooseOption(0); break;
      case 'option2': game.chooseOption(1); break;
    }
  });
  const panel = mountSettingsPanel(input);
  el('openSettings').addEventListener('click', () => { sfx.pick(); panel.open(); });
  el('pauseSettings').addEventListener('click', () => { sfx.pick(); panel.open(); });

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
  const applyQuality = () => {
    tier = FORCED_TIER[settings.data.quality] ?? autoTier;
    bloom.enabled = tier === 0;
    game.setShadows(tier < 2);
    resize();
  };
  const applySettings = () => {
    sfx.setVolume(settings.data.sfx);
    music.setVolume(settings.data.music);
    game.setShake(settings.data.shake);
    input.setJoystick(settings.data.joystick);
    game.refreshAbilityLabels();
    applyQuality();
  };
  settings.onChange(applySettings);
  addEventListener('resize', resize);
  applySettings();

  let last = performance.now();
  let sampleTime = 0, sampleFrames = 0;
  const watchFrameRate = (seconds: number) => {
    if (seconds > 0.25 || document.hidden) { sampleTime = sampleFrames = 0; return; }
    sampleTime += seconds;
    sampleFrames++;
    if (sampleTime < QUALITY_SAMPLE) return;
    if (sampleFrames / sampleTime < MIN_FPS && autoTier < 2) {
      autoTier++;
      if (settings.data.quality === 'auto') applyQuality();
    }
    sampleTime = sampleFrames = 0;
  };

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const seconds = (now - last) / 1000;
    watchFrameRate(seconds);
    game.update(Math.min(seconds, 0.05), input.read());
    music.setMode(document.body.dataset.screen === 'menu' ? 'menu' : game.paused ? 'rest' : game.mood);
    music.update();
    last = now;
    composer.render();
  });

  if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

start().catch((err) => {
  console.error(err);
  el('load').textContent = 'The game failed to load. Please refresh.';
});
