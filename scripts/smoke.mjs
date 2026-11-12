// Drives the game in headless Chromium: loads the menu, starts a run, walks, chops, and reports console errors.
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

const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `smoke-${name}.png`) }); console.log('screenshot', name); };
const state = async () => page.evaluate(() => {
  const g = window.game;
  const d = g?.debug ?? {};
  return { screen: document.body.dataset.screen, load: getComputedStyle(document.getElementById('load')).display, ...d };
});

console.log('open', url);
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => getComputedStyle(document.getElementById('load')).display === 'none', null, { timeout: 90000 });
await page.waitForTimeout(1500);
console.log('menu:', JSON.stringify(await state()));
await shot('menu');

// Start the first map, wait for the world, then walk around and let a wave come.
await page.click('#maps button');
await page.waitForFunction(() => document.body.dataset.screen === 'play', null, { timeout: 30000 });
await page.waitForTimeout(1200);
await shot('start');
const walk = async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };
await walk('KeyW', 900);
await walk('KeyA', 900);
await walk('KeyS', 500);
console.log('after walking:', JSON.stringify(await state()));
await shot('walk');
// Skip the tutorial and call the first wave early, then fight for a while.
await page.evaluate(() => document.getElementById('tipSkip')?.click());
await page.waitForTimeout(500);
await page.evaluate(() => window.game.callWave());
await page.waitForTimeout(6000);
await page.keyboard.press('KeyQ');
await page.waitForTimeout(4000);
await page.keyboard.press('KeyE');
await page.waitForTimeout(4000);
console.log('mid-wave:', JSON.stringify(await state()));
await shot('wave');
// Pause and resume, then back to the menu and start again, to exercise reset paths.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.click('#pause');
await page.click('#abandon');
await page.waitForTimeout(800);
console.log('menu again:', JSON.stringify(await state()));
await page.click('#maps button:nth-child(2)');
await page.waitForFunction(() => document.body.dataset.screen === 'play', null, { timeout: 60000 });
await page.waitForTimeout(2500);
console.log('second map:', JSON.stringify(await state()));
await shot('second-map');

console.log(errors.length ? `${errors.length} console problems:\n` + errors.slice(0, 15).join('\n') : 'no console errors or warnings');
await browser.close();
