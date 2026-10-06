// Shared Game Boy constants.

/** CPU clock in normal speed: T-cycles (PPU dots) per second. */
export const CLOCK_RATE = 4194304;
/** Dots per video frame: 154 lines of 456 dots. */
export const FRAME_DOTS = 70224;

export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 144;

/** Bits of IF/IE. */
export const Interrupt = {
  VBLANK: 0x01,
  STAT: 0x02,
  TIMER: 0x04,
  SERIAL: 0x08,
  JOYPAD: 0x10,
};
