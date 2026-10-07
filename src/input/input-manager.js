import { Button } from '../core/buttons.js';

const HORIZONTAL = Button.LEFT | Button.RIGHT;
const VERTICAL = Button.UP | Button.DOWN;

/**
 * Merges input sources (keyboard, gamepad, touch, motion, ...). A source is
 * any object with poll(): { buttons: number, fastForward: boolean } and
 * optionally tiltX/tiltY (in g, for tilt-sensor cartridges).
 */
export class InputManager {
  constructor(sources = []) {
    this.sources = sources;
  }

  add(source) {
    this.sources.push(source);
  }

  poll() {
    let buttons = 0;
    let fastForward = false;
    let tiltX = 0;
    let tiltY = 0;
    for (const source of this.sources) {
      const state = source.poll();
      buttons |= state.buttons;
      fastForward ||= state.fastForward;
      tiltX += state.tiltX ?? 0;
      tiltY += state.tiltY ?? 0;
    }
    // The D-pad can't press opposite directions at once; some games break if they see it.
    if ((buttons & HORIZONTAL) === HORIZONTAL) buttons &= ~HORIZONTAL;
    if ((buttons & VERTICAL) === VERTICAL) buttons &= ~VERTICAL;
    return { buttons, fastForward, tiltX: clampTilt(tiltX), tiltY: clampTilt(tiltY) };
  }
}

function clampTilt(value) {
  return Math.max(-1.5, Math.min(1.5, value));
}
