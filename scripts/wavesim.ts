// Prints each map's wave sizes and enemy health using the game's own formulas.
// Run: npm run sim
import { CALM, ENEMIES, enemyHp, waveComposition, type EnemyKind } from '../src/data';
import { MAPS } from '../src/maps';
import { reseed } from '../src/rng';

reseed(7);
const KINDS: EnemyKind[] = ['Minion', 'Runner', 'Warrior', 'Hexer', 'Boss'];
for (const map of MAPS) {
  console.log(`\n=== ${map.name} (${map.waves} waves) ===`);
  console.log('wave  ' + KINDS.map((k) => k.padStart(7)).join('') + '   foes  totalHP  bossHP');
  for (let w = 1; w <= map.waves; w++) {
    const comp = waveComposition(w, map, CALM);
    const counts = KINDS.map((k) => comp.filter((c) => c === k).length);
    const total = comp.reduce((sum, k) => sum + enemyHp(k, w, map), 0);
    const boss = comp.includes('Boss') ? enemyHp('Boss', w, map) : '-';
    console.log(String(w).padStart(4) + '  ' + counts.map((n) => String(n).padStart(7)).join('') + String(comp.length).padStart(7) + String(total).padStart(9) + String(boss).padStart(8));
  }
}
console.log('\nCaps per kind:', KINDS.map((k) => `${k} ${ENEMIES[k].cap}`).join(', '));
