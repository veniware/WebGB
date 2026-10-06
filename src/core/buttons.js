/**
 * Console buttons as a bitmask shared by every input source and core.
 *
 * Bit order matches the GBA KEYINPUT register and the Game Boy joypad
 * nibbles (bits 0-3: A, B, Select, Start; bits 4-7: Right, Left, Up, Down),
 * so cores can use the mask with minimal translation.
 */
export const Button = Object.freeze({
  A: 1 << 0,
  B: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  RIGHT: 1 << 4,
  LEFT: 1 << 5,
  UP: 1 << 6,
  DOWN: 1 << 7,
  R: 1 << 8,
  L: 1 << 9,
});

/** Button names in bit order. */
export const BUTTON_NAMES = Object.freeze(Object.keys(Button));
