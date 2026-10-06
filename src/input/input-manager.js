import { Button } from '../core/buttons.js';

const HORIZONTAL = Button.LEFT | Button.RIGHT;
const VERTICAL = Button.UP | Button.DOWN;

/**
 * Merges input sources (keyboard, gamepad, touch, ...). A source is any
 * object with poll(): { buttons: number, fastForward: boolean }.
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
    for (const source of this.sources) {
      const state = source.poll();
      buttons |= state.buttons;
      fastForward ||= state.fastForward;
    }
    // The D-pad can't press opposite directions at once; some games break if they see it.
    if ((buttons & HORIZONTAL) === HORIZONTAL) buttons &= ~HORIZONTAL;
    if ((buttons & VERTICAL) === VERTICAL) buttons &= ~VERTICAL;
    return { buttons, fastForward };
  }
}
