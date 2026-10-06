import { Button } from '../core/buttons.js';

// A pointer counts as a diagonal on the D-pad when its angle is within this
// ratio of both axes (tan 67.5°), giving eight equal 45° sectors.
const DIAGONAL_RATIO = 2.414;
const DPAD_DEADZONE = 0.2;

/**
 * On-screen controls. Elements inside `root` declare what they do:
 * data-button="A" (a Button name), data-dpad, or data-action="fastForward".
 * Each finger is tracked separately and can slide between controls.
 */
export class TouchInput {
  enabled = true;
  #pointers = new Map();
  #state = { buttons: 0, fastForward: false };
  // Buttons pressed since the last poll, so a tap shorter than a frame still registers.
  #tapped = 0;

  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    const track = (e) => {
      if (e.type === 'pointerdown') {
        e.preventDefault();
        root.setPointerCapture(e.pointerId);
      } else if (!this.#pointers.has(e.pointerId)) {
        return;
      }
      this.#pointers.set(e.pointerId, this.#hit(e.clientX, e.clientY));
      this.#refresh();
    };
    const release = (e) => {
      if (this.#pointers.delete(e.pointerId)) this.#refresh();
    };
    root.addEventListener('pointerdown', track);
    root.addEventListener('pointermove', track);
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  poll() {
    const { buttons, fastForward } = this.#state;
    const tapped = this.#tapped;
    this.#tapped = 0;
    return this.enabled ? { buttons: buttons | tapped, fastForward } : { buttons: 0, fastForward: false };
  }

  #hit(x, y) {
    const el = document.elementFromPoint(x, y)?.closest('[data-button], [data-dpad], [data-action]');
    if (!el || !this.root.contains(el)) return { buttons: 0, fastForward: false };
    if (el.dataset.action === 'fastForward') return { buttons: 0, fastForward: true };
    if (el.dataset.button) return { buttons: Button[el.dataset.button] ?? 0, fastForward: false };

    const rect = el.getBoundingClientRect();
    const dx = (x - rect.left) / rect.width - 0.5;
    const dy = (y - rect.top) / rect.height - 0.5;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    let buttons = 0;
    if (ax > DPAD_DEADZONE / 2 && ay < ax * DIAGONAL_RATIO) buttons |= dx < 0 ? Button.LEFT : Button.RIGHT;
    if (ay > DPAD_DEADZONE / 2 && ax < ay * DIAGONAL_RATIO) buttons |= dy < 0 ? Button.UP : Button.DOWN;
    return { buttons, fastForward: false };
  }

  #refresh() {
    let buttons = 0;
    let fastForward = false;
    for (const state of this.#pointers.values()) {
      buttons |= state.buttons;
      fastForward ||= state.fastForward;
    }
    const pressed = buttons & ~this.#state.buttons;
    if (pressed) navigator.vibrate?.(8);
    this.#tapped |= pressed;
    this.#state = { buttons, fastForward };

    for (const el of this.root.querySelectorAll('[data-button]')) {
      el.classList.toggle('pressed', !!(buttons & Button[el.dataset.button]));
    }
    for (const el of this.root.querySelectorAll('[data-action="fastForward"]')) {
      el.classList.toggle('pressed', fastForward);
    }
    for (const el of this.root.querySelectorAll('[data-dpad]')) {
      for (const dir of ['UP', 'DOWN', 'LEFT', 'RIGHT']) {
        el.classList.toggle(dir.toLowerCase(), !!(buttons & Button[dir]));
      }
    }
  }
}
