import type { Input } from './hero';
import { MOVES, settings, type Action, type JoystickMode } from './settings';

/** Everything a key or button can do besides walking. */
export type InputAction = Exclude<Action, 'up' | 'down' | 'left' | 'right'> | 'option1' | 'option2';

const el = (id: string) => document.getElementById(id)!;
const RADIUS = 44;
const DEADZONE = 0.22;
/** Standard-mapping gamepad buttons: face buttons pick cards, Y calls the wave, bumpers choose the wave option, triggers fire abilities. */
const PAD_BUTTONS: Record<number, InputAction> = { 0: 'pick1', 1: 'pick2', 2: 'pick3', 3: 'call', 4: 'option1', 5: 'option2', 6: 'ability1', 7: 'ability2', 8: 'mute', 9: 'pause' };

/** Keyboard, touch stick and gamepad, read once a frame for movement and reported as actions for everything else. */
export class InputController {
  /** While a panel is open, keys do nothing but the one being captured. */
  blocked = false;
  private keys = new Set<string>();
  private capture: ((code: string) => void) | null = null;
  private stick = el('stick');
  private nub = el('nub');
  private pointer: number | null = null;
  private ox = 0;
  private oy = 0;
  private sx = 0;
  private sz = 0;
  private mode: JoystickMode = settings.data.joystick;
  private padWas: boolean[] = [];

  constructor(private onAction: (action: InputAction) => void) {
    addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code);
        return;
      }
      if (this.blocked || (e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
      this.keys.add(e.code);
      if (e.repeat) return;
      const action = settings.actionFor(e.code);
      if (action && !MOVES.has(action)) this.onAction(action as InputAction);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button, input, select, textarea, #settings, #keep')) return;
      if (this.mode === 'left' && e.clientX > innerWidth / 2) return;
      if (this.mode === 'right' && e.clientX < innerWidth / 2) return;
      this.pointer = e.pointerId;
      [this.ox, this.oy] = this.base(e);
      this.sx = this.sz = 0;
      this.stick.style.left = `${this.ox}px`;
      this.stick.style.top = `${this.oy}px`;
      this.stick.style.display = 'block';
      this.nub.style.transform = '';
      if (this.mode !== 'floating') this.drag(e);
    });
    addEventListener('pointermove', (e) => { if (e.pointerId === this.pointer) this.drag(e); });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.pointer) return;
      this.pointer = null;
      this.sx = this.sz = 0;
      this.stick.style.display = 'none';
    };
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  }

  /** Where the stick sits: under the finger, or anchored in a corner. */
  private base(e: PointerEvent): [number, number] {
    if (this.mode === 'left') return [110, innerHeight - 120];
    if (this.mode === 'right') return [innerWidth - 110, innerHeight - 210];
    return [e.clientX, e.clientY];
  }

  private drag(e: PointerEvent): void {
    const dx = e.clientX - this.ox, dy = e.clientY - this.oy;
    const len = Math.hypot(dx, dy);
    const k = len > RADIUS ? RADIUS / len : 1;
    this.nub.style.transform = `translate(${dx * k}px,${dy * k}px)`;
    this.sx = len > 6 ? (dx * k) / RADIUS : 0;
    this.sz = len > 6 ? (dy * k) / RADIUS : 0;
  }

  /** The next key pressed goes to `cb` instead of the game. */
  captureNext(cb: (code: string) => void): void { this.capture = cb; }
  cancelCapture(): void { this.capture = null; }
  setJoystick(mode: JoystickMode): void { this.mode = mode; }

  private held(action: Action): boolean {
    for (const code of settings.data.keys[action]) if (this.keys.has(code)) return true;
    return false;
  }

  /** Movement this frame, from every source combined. */
  read(): Input {
    let x = this.sx, z = this.sz;
    if (!this.blocked) {
      if (this.held('left')) x -= 1;
      if (this.held('right')) x += 1;
      if (this.held('up')) z -= 1;
      if (this.held('down')) z += 1;
    }
    const pad = this.pollGamepad();
    x += pad.x;
    z += pad.z;
    const len = Math.hypot(x, z);
    return len > 1 ? { x: x / len, z: z / len } : { x, z };
  }

  private pollGamepad(): Input {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (!pad) { this.padWas = []; return { x: 0, z: 0 }; }
    let x = pad.axes[0] ?? 0, z = pad.axes[1] ?? 0;
    if (Math.hypot(x, z) < DEADZONE) x = z = 0;
    if (pad.buttons[12]?.pressed) z -= 1;
    if (pad.buttons[13]?.pressed) z += 1;
    if (pad.buttons[14]?.pressed) x -= 1;
    if (pad.buttons[15]?.pressed) x += 1;
    pad.buttons.forEach((b, i) => {
      const was = this.padWas[i] ?? false;
      if (b.pressed && !was && !this.blocked) {
        const action = PAD_BUTTONS[i];
        if (action) this.onAction(action);
      }
      this.padWas[i] = b.pressed;
    });
    return { x, z };
  }
}
