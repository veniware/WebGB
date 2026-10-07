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

  /**
   * @param {number} [players] 2 when two linked games run: player 2's input
   *   (second gamepad, second keyboard layout) is then reported as buttons2.
   */
  poll(players = 1) {
    let buttons = 0;
    let buttons2 = 0;
    let fastForward = false;
    let tiltX = 0;
    let tiltY = 0;
    for (const source of this.sources) {
      const state = source.poll(players);
      buttons |= state.buttons;
      buttons2 |= state.buttons2 ?? 0;
      fastForward ||= state.fastForward;
      tiltX += state.tiltX ?? 0;
      tiltY += state.tiltY ?? 0;
    }
    // The D-pad can't press opposite directions at once; some games break if they see it.
    return {
      buttons: cancelOpposites(buttons),
      buttons2: cancelOpposites(buttons2),
      fastForward,
      tiltX: clampTilt(tiltX),
      tiltY: clampTilt(tiltY),
    };
  }
}

function cancelOpposites(buttons) {
  if ((buttons & HORIZONTAL) === HORIZONTAL) buttons &= ~HORIZONTAL;
  if ((buttons & VERTICAL) === VERTICAL) buttons &= ~VERTICAL;
  return buttons;
}

function clampTilt(value) {
  return Math.max(-1.5, Math.min(1.5, value));
}
