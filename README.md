# Palisade

Chop wood, raise towers and hold your walls against a horde of skeletons. A free medieval horde-defense roguelite that runs in the browser, built with Three.js and TypeScript.

**Play:** https://njn-r.github.io/Kingshot/

## Design pillars

- **You are the economy.** Every tower, barricade and hut is paid for by walking wood and gold onto its ring. Standing still to build is the risk.
- **Every wave is a choice.** Hold steady or raise the stakes; call the wave early for gold; leave the walls to raze a camp or open a chest.
- **Builds, not numbers.** Boons change how things work (bolts that ricochet, burst or chill; towers that chain lightning; barricades that shoot), keystones trade one strength for another, and relics define a run.
- **Every foe asks a question.** Shieldbearers turn bolts from the front, archers outrange you, sappers ignore you for your walls, and each boss telegraphs an attack you can dodge.
- **Come back tomorrow.** A seeded daily challenge, achievements that unlock classes and relics, and runs that save between waves.

## What's in the game

| | |
|---|---|
| Classes | Warden, Ranger, Barbarian, Mage, Rogue, each with a weapon, a passive and two abilities |
| Maps | Greenhollow, Thornford (river and bridge), Frostmere, Ashfall, unlocked in that order |
| Foes | Minions, runners, warriors, hexers, shieldbearers, archers, sappers, elites, and a two-phase boss per map |
| Progression | 17 boons, 3 keystones, 5 endless boons, 13 relics, 6 Keep upgrades, 19 achievements |
| Modes | 12–15 wave campaigns, endless after a win, and a daily challenge with one of 7 run-wide rules |

## Controls

| Action | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Walk | WASD or arrows | Left stick or d-pad | Drag anywhere (or a fixed stick, in Settings) |
| Abilities | Q, E | Triggers | Round buttons, bottom right |
| Call the next wave | C | Y | "Call now" button |
| Choose wave option | 1, 2 | Bumpers | Tap an option |
| Pick a boon | 1, 2, 3 | A, B, X | Tap a card |
| Pause | Esc or P | Start | Pause button |
| Mute | M | Back | Sound button |

Keys can be rebound in Settings, which also holds sound and music volume, screen shake, vibration, graphics quality and the touch stick layout.

Shooting is automatic: the hero fires at the nearest foe in range. Stand on a ring to pay into it.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run build      # typecheck and production build to dist/
npm run sim        # print every map's wave sizes and enemy health
npm run smoke      # drive the running dev server in headless Chromium
```

In a dev build, `window.game` is exposed with `game.debug` (state) and `game.cheat` (jump waves, grant gold, cards and relics, spawn foes or the boss), and every class and map is unlocked.

### Code map

| File | What it does |
|---|---|
| `src/main.ts` | Boot, renderer and post-processing, quality tiers, wiring the menu and buttons |
| `src/game.ts` | One run: waves, rewards, boons, relics, the merchant, abilities, saving and resuming |
| `src/horde.ts` | The enemy pool: pathing through gates, sieges, ranged foes, shields, boss phases |
| `src/projectiles.ts` | Bolts and their boon rules, orbs and bone arrows, boulders, fireballs, burning ground |
| `src/economy.ts` | Trees, coins, build rings, towers, barricades, huts, traps, the Keep, cottages and the mine |
| `src/hero.ts`, `src/classes.ts`, `src/abilities.ts` | The player character, the five classes and their abilities |
| `src/data.ts`, `src/maps.ts`, `src/daily.ts`, `src/achievements.ts` | Game data: foes, waves, towers, boons, relics, weapons, maps, daily rules, achievements |
| `src/save.ts`, `src/settings.ts` | Versioned saves with migrations and export/import; player preferences |
| `src/input.ts`, `src/hud.ts`, `src/menu.ts`, `src/settingsUi.ts` | Keyboard, touch and gamepad; the HTML overlay; the menu, Keep and records |
| `src/music.ts`, `src/sfx.ts` | Generative music and synthesized sound effects (no audio files ship) |
| `src/rng.ts` | Seeded random streams for combat and for choices |

### Saves

Progress lives in `localStorage` under `palisade.save`. When the shape changes, bump `SAVE_VERSION` in `src/save.ts` and add a step to `MIGRATIONS`; old saves upgrade in place instead of being wiped. Players can move progress between devices with Export and Import in the Records panel.

### Assets

Models come from the CC0 packs below, unpacked under `asset-source/` (not committed).

- `npm run assets:import` copies the models the game uses into `public/models/`.
- `npm run assets:optimize` meshopt-compresses them in place (about 63% smaller), backing up originals to `asset-source/models-original/` first.
- `npm run images` regenerates the app icons and the share image.

### Deploying

Every push to `main` runs the tests and builds. To publish to GitHub Pages, set **Settings > Pages > Source** to GitHub Actions and add the repository variable `DEPLOY_PAGES` = `true`; every push to `main` then deploys `dist/`. The build is a static site with relative paths, so it can be hosted from any folder. It is installable as an app and plays offline after the first visit.

Analytics are off by default. Set the repository variable `PLAUSIBLE_DOMAIN` (or `VITE_PLAUSIBLE_DOMAIN` locally) to load [Plausible](https://plausible.io) and record run starts and ends, abilities, boons, resumes and shares.

## Credits

Art by [KayKit](https://kaylousberg.com/game-assets) (Adventurers, Skeletons, Medieval Hexagon) and [Kenney](https://kenney.nl) (Castle Kit), all CC0. Licenses are in `public/licenses/`.
