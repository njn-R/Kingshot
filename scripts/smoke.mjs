// Drives the game in headless Chromium against a running dev server and reports console errors.
// Covers the menu, every class and its abilities, new enemy types, a boss phase change, the river map,
// the daily, quitting and resuming a saved run, and the records panel.
// Usage: node scripts/smoke.mjs [url] (default http://localhost:5173). Screenshots go to scratch/smoke-*.png.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const url = process.argv[2] ?? 'http://localhost:5173';
const outDir = process.env.SMOKE_OUT ?? path.join(process.cwd(), 'scratch');
fs.mkdirSync(outDir, { recursive: true });

/** The Chromium that Playwright has already downloaded for this user, so nothing new is fetched. */
function findChromium() {
  const root = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const exe = path.join(root, d, sub, 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('No Playwright Chromium found under ' + root);
}

const browser = await chromium.launch({
  executablePath: findChromium(), headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('dialog', (d) => d.accept());

const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `smoke-${name}.png`) }); console.log('  screenshot', name); };
const state = () => page.evaluate(() => ({ screen: document.body.dataset.screen, ...(window.game?.debug ?? {}) }));
const wait = (ms) => page.waitForTimeout(ms);
const summary = (s) => `cls=${s.cls} wave=${s.wave} hp=${s.hp}/${s.maxHp} kills=${s.kills} active=${s.active} boss=${s.boss} phase=${s.phase} daily=${s.daily} weapon=${s.weapon}`;
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failures++; };

console.log('open', url);
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => getComputedStyle(document.getElementById('load')).display === 'none', null, { timeout: 120000 });
await wait(1200);
await shot('menu');
const menu = await page.evaluate(() => ({
  classes: document.querySelectorAll('#classes .cls').length,
  maps: document.querySelectorAll('#maps .map').length,
  daily: document.getElementById('dailyText').textContent,
}));
check(menu.classes === 5 && menu.maps === 4 && menu.daily.length > 5, `menu shows 5 classes, 4 maps and a daily (${menu.daily})`);

// Every class: start Greenhollow, skip the tutorial, call a wave, use both abilities, fight a little.
const classes = ['warden', 'ranger', 'barbarian', 'mage', 'rogue'];
for (const [i, cls] of classes.entries()) {
  await page.click(`#classes .cls:nth-child(${i + 1})`);
  await page.click('#maps .map:nth-child(1)');
  await page.waitForFunction(() => document.body.dataset.screen === 'play', null, { timeout: 60000 });
  await wait(600);
  await page.evaluate(() => document.getElementById('tipSkip')?.click());
  await wait(300);
  await page.evaluate(() => window.game.callWave());
  await wait(3500);
  await page.keyboard.press('KeyQ');
  await wait(1200);
  await page.keyboard.press('KeyE');
  await wait(2500);
  const s = await state();
  check(s.cls === cls && s.wave >= 1, `${cls}: ${summary(s)}`);
  if (cls === 'mage') await shot('mage');
  await page.click('#pause');
  await page.click('#abandon');
  await wait(500);
}

// New foes and a boss phase change, via dev cheats.
await page.click('#classes .cls:nth-child(1)');
await page.click('#maps .map:nth-child(1)');
await page.waitForFunction(() => document.body.dataset.screen === 'play', null, { timeout: 60000 });
await page.evaluate(() => { document.getElementById('tipSkip')?.click(); const c = window.game.cheat; for (const k of ['Shieldbearer', 'Archer', 'Sapper']) c.spawn(k); c.boss(); });
await wait(2500);
await page.evaluate(() => window.game.cheat.hurtBoss(0.55));
await wait(4000);
let s = await state();
check(s.boss && s.phase === 2, `boss enraged at half health: ${summary(s)}`);
await shot('boss');
await page.click('#pause');
await page.click('#abandon');
await wait(500);

// Thornford: the river map.
await page.click('#maps .map:nth-child(2)');
await page.waitForFunction(() => document.body.dataset.screen === 'play', null, { timeout: 60000 });
await page.evaluate(() => window.game.callWave());
await wait(4000);
s = await state();
check(s.wave === 1, `Thornford runs: ${summary(s)}`);
await shot('thornford');

// Save between waves, quit, resume from the menu.
await page.evaluate(() => { window.game.cheat.gold(80); window.game.cheat.save(); });
await page.click('#pause');
await page.click('#quitSave');
await wait(800);
const cont = await page.evaluate(() => getComputedStyle(document.getElementById('continueRun')).display !== 'none' && document.getElementById('continueRun').textContent);
check(!!cont, `continue button offered: ${cont}`);
await page.click('#continueRun');
await page.waitForFunction(() => document.body.dataset.screen === 'play', null, { timeout: 60000 });
await wait(1200);
s = await state();
check(s.wave >= 1 && s.gold >= 80, `resumed run: ${summary(s)} gold=${s.gold}`);
await page.click('#pause');
await page.click('#abandon');
await wait(800);

// The daily.
await page.click('#dailyGo');
await page.waitForFunction(() => document.body.dataset.screen === 'play', null, { timeout: 60000 });
await wait(1500);
s = await state();
check(!!s.daily, `daily started: ${summary(s)}`);
await shot('daily');
await page.click('#pause');
await page.click('#abandon');
await wait(800);

// Records and settings panels open and close.
await page.click('#openRecords');
await wait(400);
await shot('records');
const ach = await page.evaluate(() => document.querySelectorAll('#achList .ach').length);
check(ach > 10, `records lists ${ach} achievements`);
await page.click('#closeRecords');
await page.click('#openSettings');
await wait(300);
await shot('settings');
await page.click('#closeSettings');

console.log(errors.length ? `${errors.length} console problems:\n` + [...new Set(errors)].slice(0, 20).join('\n') : 'no console errors or warnings');
console.log(failures ? `${failures} checks failed` : 'all checks passed');
await browser.close();
process.exit(failures || errors.length ? 1 : 0);
