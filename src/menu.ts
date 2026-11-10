import { META, metaCost } from './data';
import { MAPS, type MapDef } from './maps';
import { save } from './save';
import type { Sfx } from './sfx';

const el = (id: string) => document.getElementById(id)!;

function tag<K extends keyof HTMLElementTagNameMap>(name: K, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  node.textContent = text;
  return node;
}

/** Fills in the map list and the Keep; returns a function that redraws saved values. */
export function createMenu(sfx: Sfx, onPlay: (map: MapDef) => void): () => void {
  const records = new Map<string, HTMLElement>();
  for (const map of MAPS) {
    const b = tag('button');
    b.type = 'button';
    b.className = 'map';
    const swatch = tag('i');
    swatch.style.background = `linear-gradient(135deg,${map.look.swatch[0]},${map.look.swatch[1]})`;
    const meta = tag('em');
    records.set(map.id, meta);
    b.append(swatch, tag('strong', map.name), tag('span', map.blurb), meta);
    b.addEventListener('click', () => { sfx.pick(); onPlay(map); });
    el('maps').append(b);
  }

  const refresh = () => {
    el('treasury').textContent = `${save.data.treasury}`;
    el('keepGold').textContent = `${save.data.treasury}`;
    for (const map of MAPS) {
      const best = save.data.best[map.id];
      const result = best ? (best.won ? (best.endless ? `Held · Endless wave ${best.endless}` : 'Held') : `Best wave ${best.wave}`) : `${map.waves} waves`;
      records.get(map.id)!.textContent = `${map.difficulty} · ${result}`;
    }
    const list = el('keepList');
    list.replaceChildren();
    for (const item of META) {
      const level = save.level(item.id);
      const row = tag('div');
      row.className = 'keepRow';
      const info = tag('div');
      const pips = tag('small', `${'●'.repeat(level)}${'○'.repeat(item.max - level)}`);
      info.append(tag('strong', item.title), tag('span', item.text), pips);
      const buy = tag('button');
      buy.type = 'button';
      if (level >= item.max) {
        buy.textContent = 'Full';
        buy.disabled = true;
      } else {
        const cost = metaCost(item, level);
        buy.textContent = `${cost} gold`;
        buy.disabled = save.data.treasury < cost;
        buy.addEventListener('click', () => {
          if (save.buy(item.id, cost)) { sfx.levelUp(); refresh(); }
        });
      }
      row.append(info, buy);
      list.append(row);
    }
  };

  el('openKeep').addEventListener('click', () => { sfx.pick(); refresh(); el('keep').style.display = 'flex'; });
  el('closeKeep').addEventListener('click', () => { el('keep').style.display = 'none'; refresh(); });
  refresh();
  return refresh;
}
