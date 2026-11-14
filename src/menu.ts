import { ABILITIES } from './abilities';
import { ACHIEVEMENTS } from './achievements';
import { CLASSES, classById, classUnlocked, type HeroClass } from './classes';
import { dailyFor, type Daily } from './daily';
import { META, metaCost } from './data';
import { isSnapshot, type RunSnapshot } from './game';
import { MAPS, type MapDef } from './maps';
import { save } from './save';
import type { Sfx } from './sfx';

const el = (id: string) => document.getElementById(id)!;

function tag<K extends keyof HTMLElementTagNameMap>(name: K, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  node.textContent = text;
  return node;
}

export interface MenuActions {
  play(map: MapDef, cls: HeroClass): void;
  daily(daily: Daily, cls: HeroClass): void;
  resume(run: RunSnapshot): void;
}

/** A map opens once the one before it has been held, or if it has been played before. */
export const mapUnlocked = (map: MapDef): boolean =>
  !map.unlock || !!save.data.best[map.unlock]?.won || !!save.data.best[map.id] || import.meta.env.DEV;

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** Fills in the class row, the map list, the daily, the Keep and the records; returns a function that redraws saved values. */
export function createMenu(sfx: Sfx, actions: MenuActions): () => void {
  let chosen = classById(save.data.lastClass);
  if (!classUnlocked(chosen)) chosen = CLASSES[0];
  const classButtons = new Map<string, HTMLButtonElement>();

  const markClass = () => {
    for (const [id, b] of classButtons) b.classList.toggle('chosen', id === chosen.id);
  };
  const drawClasses = () => {
    const row = el('classes');
    row.replaceChildren();
    classButtons.clear();
    for (const cls of CLASSES) {
      const b = tag('button');
      b.type = 'button';
      b.className = 'cls';
      const open = classUnlocked(cls);
      const abilities = cls.abilities.map((id) => ABILITIES[id].title).join(' · ');
      b.append(tag('strong', cls.title), tag('span', open ? cls.passive : `Locked: ${cls.unlockHint}`), tag('em', open ? abilities : cls.text));
      b.disabled = !open;
      b.addEventListener('click', () => {
        chosen = cls;
        save.setLastClass(cls.id);
        sfx.pick();
        markClass();
      });
      classButtons.set(cls.id, b);
      row.append(b);
    }
    markClass();
  };

  const mapButtons = new Map<string, { button: HTMLButtonElement; meta: HTMLElement }>();
  for (const map of MAPS) {
    const b = tag('button');
    b.type = 'button';
    b.className = 'map';
    const swatch = tag('i');
    swatch.style.background = `linear-gradient(135deg,${map.look.swatch[0]},${map.look.swatch[1]})`;
    const meta = tag('em');
    mapButtons.set(map.id, { button: b, meta });
    b.append(swatch, tag('strong', map.name), tag('span', map.blurb), meta);
    b.addEventListener('click', () => { sfx.pick(); actions.play(map, chosen); });
    el('maps').append(b);
  }

  el('dailyGo').addEventListener('click', () => { sfx.pick(); actions.daily(dailyFor(), chosen); });
  el('continueRun').addEventListener('click', () => {
    const run = save.data.run;
    if (isSnapshot(run)) { sfx.pick(); actions.resume(run); }
  });

  const drawDaily = () => {
    const d = dailyFor();
    const done = save.data.daily[d.key];
    const streak = save.data.streak.count > 1 && (save.data.streak.last === d.key || done) ? ` · ${save.data.streak.count}-day streak` : '';
    el('dailyText').textContent = `${d.map.name} · ${d.mod.title}: ${d.mod.text}`;
    el('dailyBest').textContent = done ? `Today: ${done.won ? 'held' : `wave ${done.wave}`}, ${done.kills} slain${streak}` : `Not yet played today${streak}`;
    (el('dailyGo') as HTMLButtonElement).textContent = done ? 'Play again' : 'Play the daily';
  };

  const drawContinue = () => {
    const run = save.data.run;
    const button = el('continueRun') as HTMLButtonElement;
    if (!isSnapshot(run)) { button.style.display = 'none'; return; }
    const map = MAPS.find((m) => m.id === run.map)!;
    button.style.display = '';
    button.textContent = `Continue: ${map.name}, wave ${run.wave + 1}, ${classById(run.cls).title}${run.daily ? ' (daily)' : ''}`;
  };

  const drawRecords = () => {
    const s = save.data.stats;
    const stats: Array<[string, string]> = [
      ['Runs', `${s.runs}`], ['Maps held', `${s.wins}`], ['Foes slain', `${s.kills}`], ['Bosses felled', `${s.bosses}`], ['Elites slain', `${s.elites}`],
      ['Camps razed', `${s.camps}`], ['Chests opened', `${s.chests}`], ['Things built', `${s.built}`], ['Gold banked', `${s.gold}`],
      ['Longest endless', `${s.endless} waves`], ['Time defending', time(s.seconds)], ['Daily streak', `${save.data.streak.count}`],
    ];
    el('statList').replaceChildren(...stats.map(([k, v]) => { const row = tag('div'); row.append(tag('span', k), tag('b', v)); return row; }));
    el('achList').replaceChildren(...ACHIEVEMENTS.map((a) => {
      const row = tag('div');
      row.className = save.has(a.id) ? 'ach got' : 'ach';
      row.append(tag('strong', `${save.has(a.id) ? '✓ ' : ''}${a.title}`), tag('span', a.text + (a.reward ? `. Unlocks ${a.reward}` : '')));
      return row;
    }));
    const history = save.data.history.slice(0, 12);
    el('historyList').replaceChildren(...(history.length ? history.map((r) => {
      const map = MAPS.find((m) => m.id === r.map)?.name ?? r.map;
      const result = r.won ? (r.endless ? `held, +${r.endless} endless` : 'held') : `fell at wave ${r.wave}`;
      return tag('li', `${new Date(r.at).toLocaleDateString()} · ${map} · ${classById(r.cls).title} · ${result} · ${r.kills} slain${r.daily ? ' · daily' : ''}`);
    }) : [tag('li', 'No runs yet.')]));
    (el('saveText') as HTMLTextAreaElement).value = '';
  };

  const refresh = () => {
    drawClasses();
    drawDaily();
    drawContinue();
    el('treasury').textContent = `${save.data.treasury}`;
    el('keepGold').textContent = `${save.data.treasury}`;
    for (const map of MAPS) {
      const { button, meta } = mapButtons.get(map.id)!;
      const open = mapUnlocked(map);
      button.disabled = !open;
      const best = save.data.best[map.id];
      const result = best ? (best.won ? (best.endless ? `Held · Endless wave ${best.endless}` : 'Held') : `Best wave ${best.wave}`) : `${map.waves} waves`;
      const before = MAPS.find((m) => m.id === map.unlock);
      meta.textContent = open ? `${map.difficulty} · ${result}` : `Locked: hold ${before?.name ?? 'the map before'}`;
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
  el('openRecords').addEventListener('click', () => { sfx.pick(); drawRecords(); el('records').style.display = 'flex'; });
  el('closeRecords').addEventListener('click', () => { el('records').style.display = 'none'; refresh(); });
  const status = el('saveStatus');
  el('exportSave').addEventListener('click', async () => {
    const text = save.export();
    (el('saveText') as HTMLTextAreaElement).value = text;
    try { await navigator.clipboard.writeText(text); status.textContent = 'Copied to the clipboard. Keep it somewhere safe.'; }
    catch { status.textContent = 'Select the text above and copy it.'; }
  });
  el('importSave').addEventListener('click', () => {
    const text = (el('saveText') as HTMLTextAreaElement).value;
    if (!text.trim()) { status.textContent = 'Paste an exported save into the box first.'; return; }
    if (!confirm('Replace all progress on this device with the pasted save?')) return;
    status.textContent = save.import(text) ? 'Save imported.' : 'That text is not a valid Palisade save.';
    drawRecords();
    refresh();
  });
  refresh();
  return refresh;
}
