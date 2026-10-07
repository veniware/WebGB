import { Button } from '../core/buttons.js';

/**
 * Gamepad API button index -> Button, for the "standard" layout. Face
 * buttons follow Nintendo positions: A is the right button, B the bottom one.
 */
export const DEFAULT_PAD_MAP = [
  [1, Button.A],
  [0, Button.B],
  [4, Button.L],
  [5, Button.R],
  [8, Button.SELECT],
  [9, Button.START],
  [12, Button.UP],
  [13, Button.DOWN],
  [14, Button.LEFT],
  [15, Button.RIGHT],
];

/** Right trigger holds fast-forward. */
export const FAST_FORWARD_BUTTON = 7;
const STICK_DEADZONE = 0.5;
// The right stick tilts tilt-sensor cartridges.
const TILT_DEADZONE = 0.15;

const isPressed = (button) => !!button && (button.pressed || button.value > 0.5);

export class GamepadInput {
  constructor(map = DEFAULT_PAD_MAP, fastForward = [FAST_FORWARD_BUTTON]) {
    this.map = map;
    this.fastForward = fastForward;
  }

  /** @param {{ map: Array<[number, number]>, fastForward: number[] }} bindings  See bindings.js. */
  setBindings({ map, fastForward }) {
    this.map = map;
    this.fastForward = fastForward;
  }

  /** Rumbles the connected gamepads that support it; strength 0-1. */
  rumble(strength, duration) {
    for (const pad of navigator.getGamepads?.() ?? []) {
      const actuator = pad?.vibrationActuator;
      if (!actuator) continue;
      if (strength > 0) {
        actuator.playEffect?.('dual-rumble', { duration, strongMagnitude: strength, weakMagnitude: strength }).catch(() => {});
      } else {
        actuator.reset?.().catch(() => {});
      }
    }
  }

  /** With two players (linked games) the second connected pad is player 2; otherwise all pads are player 1. */
  poll(players = 1) {
    let buttons = 0;
    let buttons2 = 0;
    let fastForward = false;
    let tiltX = 0;
    let tiltY = 0;
    let connected = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad?.connected) continue;
      let pressed = 0;
      for (const [index, button] of this.map) {
        if (isPressed(pad.buttons[index])) pressed |= button;
      }
      const [x = 0, y = 0] = pad.axes;
      if (x < -STICK_DEADZONE) pressed |= Button.LEFT;
      if (x > STICK_DEADZONE) pressed |= Button.RIGHT;
      if (y < -STICK_DEADZONE) pressed |= Button.UP;
      if (y > STICK_DEADZONE) pressed |= Button.DOWN;
      if (players > 1 && connected === 1) buttons2 |= pressed;
      else buttons |= pressed;
      connected++;
      if (this.fastForward.some((index) => isPressed(pad.buttons[index]))) fastForward = true;
      const [, , rx = 0, ry = 0] = pad.axes;
      if (Math.hypot(rx, ry) > TILT_DEADZONE) {
        tiltX += rx;
        tiltY += ry;
      }
    }
    return { buttons, buttons2, fastForward, tiltX, tiltY };
  }
}
