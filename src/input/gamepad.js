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
const FAST_FORWARD_BUTTON = 7;
const STICK_DEADZONE = 0.5;
// The right stick tilts tilt-sensor cartridges.
const TILT_DEADZONE = 0.15;

const isPressed = (button) => !!button && (button.pressed || button.value > 0.5);

export class GamepadInput {
  constructor(map = DEFAULT_PAD_MAP) {
    this.map = map;
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

  poll() {
    let buttons = 0;
    let fastForward = false;
    let tiltX = 0;
    let tiltY = 0;
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad?.connected) continue;
      for (const [index, button] of this.map) {
        if (isPressed(pad.buttons[index])) buttons |= button;
      }
      const [x = 0, y = 0] = pad.axes;
      if (x < -STICK_DEADZONE) buttons |= Button.LEFT;
      if (x > STICK_DEADZONE) buttons |= Button.RIGHT;
      if (y < -STICK_DEADZONE) buttons |= Button.UP;
      if (y > STICK_DEADZONE) buttons |= Button.DOWN;
      if (isPressed(pad.buttons[FAST_FORWARD_BUTTON])) fastForward = true;
      const [, , rx = 0, ry = 0] = pad.axes;
      if (Math.hypot(rx, ry) > TILT_DEADZONE) {
        tiltX += rx;
        tiltY += ry;
      }
    }
    return { buttons, fastForward, tiltX, tiltY };
  }
}
