import { Button } from '../core/buttons.js';

/** KeyboardEvent.code -> Button. */
export const DEFAULT_KEY_MAP = {
  ArrowUp: Button.UP,
  ArrowDown: Button.DOWN,
  ArrowLeft: Button.LEFT,
  ArrowRight: Button.RIGHT,
  KeyX: Button.A,
  KeyZ: Button.B,
  Enter: Button.START,
  ShiftRight: Button.SELECT,
  Backspace: Button.SELECT,
  KeyA: Button.L,
  KeyS: Button.R,
};

/** KeyboardEvent.code -> hotkey name. 'fastForward' is held; the others fire once. */
export const DEFAULT_HOTKEYS = {
  Tab: 'fastForward',
  KeyP: 'pause',
  KeyF: 'fullscreen',
  F2: 'snapshot',
  F4: 'loadSnapshot',
};

/** KeyboardEvent.code -> tilt direction, for tilt-sensor cartridges (Kirby Tilt 'n' Tumble). */
export const DEFAULT_TILT_KEYS = {
  KeyJ: [-1, 0],
  KeyL: [1, 0],
  KeyI: [0, -1],
  KeyK: [0, 1],
};

const TEXT_FIELDS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export class KeyboardInput {
  enabled = true;
  #down = new Set();
  // Keys pressed since the last poll, so a tap shorter than a frame still registers.
  #tapped = new Set();

  /**
   * @param {{ keyMap?: Record<string, number>, hotkeys?: Record<string, string>, onHotkey?: (name: string) => void }} [options]
   */
  constructor({ keyMap = DEFAULT_KEY_MAP, hotkeys = DEFAULT_HOTKEYS, tiltKeys = DEFAULT_TILT_KEYS, onHotkey = () => {} } = {}) {
    this.keyMap = keyMap;
    this.hotkeys = hotkeys;
    this.tiltKeys = tiltKeys;
    this.onHotkey = onHotkey;
    window.addEventListener('keydown', (e) => this.#keydown(e));
    window.addEventListener('keyup', (e) => this.#keyup(e));
    window.addEventListener('blur', () => {
      this.#down.clear();
      this.#tapped.clear();
    });
  }

  #keydown(e) {
    if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey || TEXT_FIELDS.has(e.target?.tagName)) return;
    const hotkey = this.hotkeys[e.code];
    if (this.keyMap[e.code] === undefined && !hotkey && !this.tiltKeys[e.code]) return;
    e.preventDefault();
    if (e.repeat) return;
    this.#down.add(e.code);
    this.#tapped.add(e.code);
    if (hotkey && hotkey !== 'fastForward') this.onHotkey(hotkey);
  }

  #keyup(e) {
    if (this.#down.delete(e.code)) e.preventDefault();
  }

  poll() {
    let buttons = 0;
    let fastForward = false;
    let tiltX = 0;
    let tiltY = 0;
    if (this.enabled) {
      for (const code of [...this.#down, ...this.#tapped]) {
        buttons |= this.keyMap[code] ?? 0;
        if (this.hotkeys[code] === 'fastForward') fastForward = true;
      }
      for (const code of this.#down) {
        const tilt = this.tiltKeys[code];
        if (tilt) {
          tiltX += tilt[0];
          tiltY += tilt[1];
        }
      }
    }
    this.#tapped.clear();
    return { buttons, fastForward, tiltX, tiltY };
  }
}
