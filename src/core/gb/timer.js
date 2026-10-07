import { Interrupt } from './constants.js';

// System-counter bit whose falling edge clocks TIMA, per TAC clock select.
const TAC_BITS = [1 << 9, 1 << 3, 1 << 5, 1 << 7];

/**
 * DIV/TIMA/TMA/TAC. Everything runs off a 16-bit system counter that
 * advances every CPU T-cycle (DIV is its upper byte). TIMA and the APU's
 * frame sequencer are clocked by falling edges of counter bits, so resetting
 * DIV or changing TAC can clock them early, as on hardware.
 */
export class Timer {
  /** @param {import('./gameboy.js').GameBoy} gb */
  constructor(gb) {
    this.gb = gb;
    this.reset(0);
  }

  reset(counter) {
    this.counter = counter;
    this.tima = 0;
    this.tma = 0;
    this.tac = 0xf8;
    // TIMA overflowed in the previous M-cycle and reads 0; it is reloaded from
    // TMA (and the interrupt raised) one M-cycle later.
    this.overflow = false;
    // TIMA was reloaded in this M-cycle; writes to TIMA are ignored and
    // writes to TMA also go to TIMA.
    this.reloaded = false;
  }

  sync(s) {
    this.counter = s.u16(this.counter);
    this.tima = s.u8(this.tima);
    this.tma = s.u8(this.tma);
    this.tac = s.u8(this.tac);
    this.overflow = s.bool(this.overflow);
    this.reloaded = s.bool(this.reloaded);
  }

  get div() {
    return this.counter >> 8;
  }

  /** Advances one M-cycle. */
  tick() {
    this.reloaded = false;
    if (this.overflow) {
      this.overflow = false;
      this.tima = this.tma;
      this.gb.if |= Interrupt.TIMER;
      this.reloaded = true;
    }
    const old = this.counter;
    this.counter = (old + 4) & 0xffff;
    this.#edges(old, this.counter);
  }

  writeDiv() {
    const old = this.counter;
    this.counter = 0;
    this.#edges(old, 0);
  }

  writeTima(value) {
    if (this.reloaded) return;
    this.overflow = false;
    this.tima = value;
  }

  writeTma(value) {
    this.tma = value;
    if (this.reloaded) this.tima = value;
  }

  writeTac(value) {
    // The enable bit is ANDed with the counter bit before edge detection, so
    // turning the timer off (or switching bits) while the bit is high clocks
    // TIMA. The write lands before the M-cycle's last counter increment,
    // which tick() has already applied with the old TAC.
    const now = this.counter;
    const mid = (now - 1) & 0xffff;
    const signal = (tac, counter) => (tac & 4) !== 0 && (counter & TAC_BITS[tac & 3]) !== 0;
    const old = this.tac;
    this.tac = 0xf8 | value;
    const counted = signal(old, mid) && !signal(old, now) ? 1 : 0;
    const due = (signal(old, mid) && !signal(this.tac, mid) ? 1 : 0) +
      (signal(this.tac, mid) && !signal(this.tac, now) ? 1 : 0);
    for (let i = counted; i < due; i++) this.#incrementTima();
  }

  /** Clocks what runs off falling edges of counter bits. */
  #edges(old, now) {
    const fallen = old & ~now;
    if (this.tac & 4 && fallen & TAC_BITS[this.tac & 3]) this.#incrementTima();
    if (fallen & (this.gb.doubleSpeed ? 0x2000 : 0x1000)) this.gb.apu.clockFrameSequencer();
    // The serial clock sees the counter one M-cycle ahead of DIV reads
    // (boot_div and boot_sclk_align agree only this way).
    if ((old + 4) & ~(now + 4) & this.gb.serial.mask) this.gb.serial.edge();
  }

  #incrementTima() {
    this.tima = (this.tima + 1) & 0xff;
    if (this.tima === 0) this.overflow = true;
  }
}
