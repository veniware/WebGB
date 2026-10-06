import { Interrupt } from './constants.js';

/**
 * Serial port (SB/SC) with nothing connected: a transfer on the internal
 * clock completes after 8 bits and reads 0xFF; on the external clock it
 * never completes. Bytes are passed to `onByte` when a transfer starts;
 * test ROMs report their results this way.
 */
export class Serial {
  /** @type {((byte: number) => void) | null} */
  onByte = null;

  /** @param {import('./gameboy.js').GameBoy} gb */
  constructor(gb) {
    this.gb = gb;
    this.reset();
  }

  reset() {
    this.sb = 0;
    this.sc = 0;
    // CPU T-cycles until the transfer completes; 0 when idle.
    this.cycles = 0;
  }

  sync(s) {
    this.sb = s.u8(this.sb);
    this.sc = s.u8(this.sc);
    this.cycles = s.u32(this.cycles);
  }

  readSc() {
    return this.sc | (this.gb.cgb ? 0x7c : 0x7e);
  }

  writeSc(value) {
    this.sc = value & (this.gb.cgb ? 0x83 : 0x81);
    if ((this.sc & 0x81) === 0x81) {
      this.onByte?.(this.sb);
      // 8 bits at 8192 Hz, or 262144 Hz with the CGB fast clock.
      this.cycles = this.sc & 2 ? 8 * 16 : 8 * 512;
    } else {
      this.cycles = 0;
    }
  }

  /** Advances one M-cycle while a transfer is running. */
  tick() {
    this.cycles -= 4;
    if (this.cycles > 0) return;
    this.cycles = 0;
    this.sb = 0xff;
    this.sc &= 0x7f;
    this.gb.if |= Interrupt.SERIAL;
  }
}
