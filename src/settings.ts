export type Action = 'up' | 'down' | 'left' | 'right' | 'ability1' | 'ability2' | 'call' | 'pause' | 'mute' | 'pick1' | 'pick2' | 'pick3';
export type Quality = 'auto' | 'high' | 'medium' | 'low';
export type JoystickMode = 'floating' | 'left' | 'right';

export interface Settings {
  /** Loudness, 0 to 1. */
  sfx: number;
  music: number;
  shake: boolean;
  vibrate: boolean;
  quality: Quality;
  joystick: JoystickMode;
  keys: Record<Action, string[]>;
}

const KEY = 'palisade.settings';

export const ACTIONS: ReadonlyArray<{ id: Action; title: string }> = [
  { id: 'up', title: 'Walk up' }, { id: 'down', title: 'Walk down' }, { id: 'left', title: 'Walk left' }, { id: 'right', title: 'Walk right' },
  { id: 'ability1', title: 'First ability' }, { id: 'ability2', title: 'Second ability' }, { id: 'call', title: 'Call the next wave' },
  { id: 'pause', title: 'Pause' }, { id: 'mute', title: 'Mute' }, { id: 'pick1', title: 'Pick first card' }, { id: 'pick2', title: 'Pick second card' }, { id: 'pick3', title: 'Pick third card' },
];

export const MOVES: ReadonlySet<Action> = new Set<Action>(['up', 'down', 'left', 'right']);

const DEFAULT_KEYS: Record<Action, string[]> = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  ability1: ['KeyQ'], ability2: ['KeyE'], call: ['KeyC'], pause: ['Escape', 'KeyP'], mute: ['KeyM'],
  pick1: ['Digit1'], pick2: ['Digit2'], pick3: ['Digit3'],
};

const copyKeys = (keys: Record<Action, string[]>): Record<Action, string[]> =>
  Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, [...v]])) as Record<Action, string[]>;

const defaults = (): Settings => ({ sfx: 1, music: 0.7, shake: true, vibrate: true, quality: 'auto', joystick: 'floating', keys: copyKeys(DEFAULT_KEYS) });

const clamp01 = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : fallback);

function read(): Settings {
  const d = defaults();
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Settings> | null;
    if (!parsed || typeof parsed !== 'object') return d;
    const keys = copyKeys(DEFAULT_KEYS);
    for (const action of Object.keys(keys) as Action[]) {
      const stored = parsed.keys?.[action];
      if (Array.isArray(stored) && stored.every((c) => typeof c === 'string') && stored.length) keys[action] = [...stored];
    }
    return {
      sfx: clamp01(parsed.sfx, d.sfx), music: clamp01(parsed.music, d.music),
      shake: typeof parsed.shake === 'boolean' ? parsed.shake : d.shake,
      vibrate: typeof parsed.vibrate === 'boolean' ? parsed.vibrate : d.vibrate,
      quality: (['auto', 'high', 'medium', 'low'] as Quality[]).includes(parsed.quality as Quality) ? (parsed.quality as Quality) : d.quality,
      joystick: (['floating', 'left', 'right'] as JoystickMode[]).includes(parsed.joystick as JoystickMode) ? (parsed.joystick as JoystickMode) : d.joystick,
      keys,
    };
  } catch {
    return d;
  }
}

/** Player preferences, kept apart from progress so they survive a save import. */
class SettingsStore {
  data = read();
  private listeners: Array<() => void> = [];

  set(patch: Partial<Settings>): void {
    Object.assign(this.data, patch);
    this.persist();
    this.emit();
  }

  /** Binds a key to one action, taking it away from any other. */
  bind(action: Action, code: string): void {
    for (const other of Object.keys(this.data.keys) as Action[]) this.data.keys[other] = this.data.keys[other].filter((c) => c !== code);
    this.data.keys[action] = [code];
    this.persist();
    this.emit();
  }

  resetKeys(): void {
    this.data.keys = copyKeys(DEFAULT_KEYS);
    this.persist();
    this.emit();
  }

  actionFor(code: string): Action | null {
    for (const action of Object.keys(this.data.keys) as Action[]) if (this.data.keys[action].includes(code)) return action;
    return null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }

  private persist(): void {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* preferences last this session only */ }
  }

  private emit(): void { for (const l of this.listeners) l(); }
}

export const settings = new SettingsStore();

/** A short name for a key code, for buttons and hints. */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    Escape: 'Esc', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Bksp', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: 'L Shift', ShiftRight: 'R Shift', ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
