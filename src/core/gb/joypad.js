import { Interrupt } from './constants.js';

/**
 * P1/JOYP. The game selects the action buttons (bit 5 = 0) and/or the
 * D-pad (bit 4 = 0) and reads pressed buttons as 0 bits. Buttons use the
 * host bitmask from src/core/buttons.js, whose low and high nibbles match
 * the two button groups.
 */
export class Joypad {
  /** @param {import('./gameboy.js').GameBoy} gb */
  constructor(gb) {
    this.gb = gb;
    this.buttons = 0;
    this.reset();
  }

  reset() {
    this.select = 0x30;
  }

  sync(s) {
    this.select = s.u8(this.select);
    this.buttons = s.u16(this.buttons);
  }

  read() {
    return 0xc0 | this.select | this.#lines();
  }

  write(value) {
    this.#update(() => (this.select = value & 0x30));
  }

  setButtons(buttons) {
    this.#update(() => (this.buttons = buttons & 0xff));
  }

  pressed() {
    return this.buttons !== 0;
  }

  /** Input lines, active low. */
  #lines() {
    let lines = 0x0f;
    if (!(this.select & 0x10)) lines &= ~(this.buttons >> 4);
    if (!(this.select & 0x20)) lines &= ~this.buttons;
    return lines & 0x0f;
  }

  /** The interrupt fires when a selected line goes from high to low. */
  #update(change) {
    const before = this.#lines();
    change();
    if (before & ~this.#lines()) this.gb.if |= Interrupt.JOYPAD;
  }
}
