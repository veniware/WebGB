import { Interrupt } from './constants.js';

/**
 * Serial port (SB/SC). The internal clock comes from the system counter
 * (bit 7, or bit 2 with the CGB's fast clock), so transfers line up with
 * DIV as on hardware. With nothing connected, bits shift in as 1s and a
 * transfer on the external clock never completes; with a link (another
 * Game Boy), the bytes are swapped when the transfer completes. Bytes are
 * passed to `onByte` when a transfer starts; test ROMs report their
 * results this way.
 */
export class Serial {
  /** @type {((byte: number) => void) | null} */
  onByte = null;
  /** @type {Serial | null} The other Game Boy, when linked. */
  link = null;

  /** @param {import('./gameboy.js').GameBoy} gb */
  constructor(gb) {
    this.gb = gb;
    this.reset();
  }

  reset() {
    this.sb = 0;
    this.sc = 0;
    // Bits shifted in the current transfer and the byte being sent.
    this.bits = 0;
    this.sending = 0;
    // The serial clock: toggled by each falling edge of `mask` in the counter.
    this.clock = false;
    this.mask = 0x80;
  }

  sync(s) {
    this.sb = s.u8(this.sb);
    this.sc = s.u8(this.sc);
    this.bits = s.u8(this.bits);
    this.sending = s.u8(this.sending);
    this.clock = s.bool(this.clock);
    this.mask = s.u16(this.mask);
  }

  readSc() {
    return this.sc | (this.gb.cgb ? 0x7c : 0x7e);
  }

  writeSc(value) {
    // Reported as written: test ROMs don't always wait for the last transfer.
    const written = this.sb;
    this.bits = 0;
    if (this.clock) this.edge();
    this.sc = value & (this.gb.cgb ? 0x83 : 0x81);
    this.mask = this.sc & 2 ? 0x04 : 0x80;
    if ((this.sc & 0x81) === 0x81) {
      this.sending = this.sb;
      this.onByte?.(written);
    }
  }

  /**
   * A falling edge of the clocking counter bit. A bit is shifted every
   * second edge; after 8, a linked Game Boy waiting on the external clock
   * exchanges its byte.
   */
  edge() {
    this.clock = !this.clock;
    if (this.clock || (this.sc & 0x81) !== 0x81) return;
    this.sb = ((this.sb << 1) | 1) & 0xff;
    if (++this.bits < 8) return;
    this.bits = 0;
    const peer = this.link;
    if (peer && (peer.sc & 0x81) === 0x80) {
      this.sb = peer.sb;
      peer.sb = this.sending;
      peer.sc &= 0x7f;
      peer.gb.if |= Interrupt.SERIAL;
    }
    this.sc &= 0x7f;
    this.gb.if |= Interrupt.SERIAL;
  }
}
