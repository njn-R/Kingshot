import type { InputController } from './input';
import { ACTIONS, keyLabel, settings, type JoystickMode, type Quality } from './settings';

const el = (id: string) => document.getElementById(id)!;

/** Wires the settings overlay to the store; returns a way to open and close it. */
export function mountSettingsPanel(input: InputController): { open(): void; close(): void } {
  const panel = el('settings');
  const sfx = el('setSfx') as HTMLInputElement;
  const music = el('setMusic') as HTMLInputElement;
  const shake = el('setShake') as HTMLInputElement;
  const vibrate = el('setVibrate') as HTMLInputElement;
  const quality = el('setQuality') as HTMLSelectElement;
  const joystick = el('setJoystick') as HTMLSelectElement;
  const list = el('keyList');

  const renderKeys = () => {
    list.replaceChildren();
    for (const action of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'keyRow';
      const name = document.createElement('span');
      name.textContent = action.title;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = settings.data.keys[action.id].map(keyLabel).join(' / ');
      button.addEventListener('click', () => {
        for (const b of list.querySelectorAll('button')) b.classList.remove('listen');
        button.classList.add('listen');
        button.textContent = 'Press a key…';
        input.captureNext((code) => {
          settings.bind(action.id, code);
          renderKeys();
        });
      });
      row.append(name, button);
      list.append(row);
    }
  };

  const sync = () => {
    sfx.value = String(Math.round(settings.data.sfx * 100));
    music.value = String(Math.round(settings.data.music * 100));
    shake.checked = settings.data.shake;
    vibrate.checked = settings.data.vibrate;
    quality.value = settings.data.quality;
    joystick.value = settings.data.joystick;
    renderKeys();
  };

  sfx.addEventListener('input', () => settings.set({ sfx: Number(sfx.value) / 100 }));
  music.addEventListener('input', () => settings.set({ music: Number(music.value) / 100 }));
  shake.addEventListener('change', () => settings.set({ shake: shake.checked }));
  vibrate.addEventListener('change', () => settings.set({ vibrate: vibrate.checked }));
  quality.addEventListener('change', () => settings.set({ quality: quality.value as Quality }));
  joystick.addEventListener('change', () => settings.set({ joystick: joystick.value as JoystickMode }));
  el('resetKeys').addEventListener('click', () => { settings.resetKeys(); renderKeys(); });

  const open = () => { sync(); input.blocked = true; panel.style.display = 'flex'; };
  const close = () => { input.cancelCapture(); input.blocked = false; panel.style.display = 'none'; };
  el('closeSettings').addEventListener('click', close);
  return { open, close };
}
