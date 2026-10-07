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

/** KeyboardEvent.code -> hotkey name. HELD_HOTKEYS are held; the others fire once. */
export const DEFAULT_HOTKEYS = {
  Tab: 'fastForward',
  KeyR: 'rewind',
  KeyP: 'pause',
  KeyF: 'fullscreen',
  F2: 'snapshot',
  F4: 'loadSnapshot',
  F9: 'record',
};

/** Player 2 (two linked games): WASD, G = B, H = A, T = Select, Y = Start. */
export const DEFAULT_PLAYER_2_MAP = {
  KeyW: Button.UP,
  KeyS: Button.DOWN,
  KeyA: Button.LEFT,
  KeyD: Button.RIGHT,
  KeyH: Button.A,
  KeyG: Button.B,
  KeyY: Button.START,
  KeyT: Button.SELECT,
};

/** KeyboardEvent.code -> tilt direction, for tilt-sensor cartridges (Kirby Tilt 'n' Tumble). */
export const DEFAULT_TILT_KEYS = {
  KeyJ: [-1, 0],
  KeyL: [1, 0],
  KeyI: [0, -1],
  KeyK: [0, 1],
};

const HELD_HOTKEYS = new Set(['fastForward', 'rewind']);
const TEXT_FIELDS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

export class KeyboardInput {
  enabled = true;
  #down = new Set();
  // Keys pressed since the last poll, so a tap shorter than a frame still registers.
  #tapped = new Set();

  /**
   * @param {{ keyMap?: Record<string, number>, hotkeys?: Record<string, string>, onHotkey?: (name: string) => void }} [options]
   */
  constructor({
    keyMap = DEFAULT_KEY_MAP,
    player2Map = DEFAULT_PLAYER_2_MAP,
    hotkeys = DEFAULT_HOTKEYS,
    tiltKeys = DEFAULT_TILT_KEYS,
    onHotkey = () => {},
  } = {}) {
    this.keyMap = keyMap;
    this.player2Map = player2Map;
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

  /** @param {{ keyMap: Record<string, number>, hotkeys: Record<string, string> }} maps  See bindings.js. */
  setBindings({ keyMap, hotkeys }) {
    this.keyMap = keyMap;
    this.hotkeys = hotkeys;
  }

  #keydown(e) {
    if (!this.enabled || e.ctrlKey || e.metaKey || e.altKey || TEXT_FIELDS.has(e.target?.tagName)) return;
    const hotkey = this.hotkeys[e.code];
    if (this.keyMap[e.code] === undefined && !hotkey && !this.tiltKeys[e.code] && this.player2Map[e.code] === undefined) {
      return;
    }
    e.preventDefault();
    if (e.repeat) return;
    this.#down.add(e.code);
    this.#tapped.add(e.code);
    if (hotkey && !HELD_HOTKEYS.has(hotkey)) this.onHotkey(hotkey);
  }

  #keyup(e) {
    if (this.#down.delete(e.code)) e.preventDefault();
  }

  poll(players = 1) {
    let buttons = 0;
    let buttons2 = 0;
    let fastForward = false;
    let rewind = false;
    let tiltX = 0;
    let tiltY = 0;
    if (this.enabled) {
      for (const code of [...this.#down, ...this.#tapped]) {
        buttons |= this.keyMap[code] ?? 0;
        if (players > 1) buttons2 |= this.player2Map[code] ?? 0;
        if (this.hotkeys[code] === 'fastForward') fastForward = true;
      }
      for (const code of this.#down) {
        if (this.hotkeys[code] === 'rewind') rewind = true;
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
    return { buttons, buttons2, fastForward, rewind, tiltX, tiltY };
  }
}
