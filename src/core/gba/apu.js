export const SAMPLE_RATE = 48000;

/** Sound: not emulated yet (silence). */
export class Apu {
  constructor(hooks) {
    this.hooks = hooks;
    this.regs = new Uint16Array(0x28);
    this.buffer = new Float32Array(4096);
    this.nextEvent = Infinity;
    this.reset();
  }

  reset() {
    this.regs.fill(0);
    this.length = 0;
  }

  sync(s) {
    s.bytes(this.regs);
  }

  get samples() {
    return this.buffer.subarray(0, this.length);
  }

  beginFrame() {
    this.length = 0;
  }

  endFrame() {
    this.length = 1600;
  }

  read16(address) {
    return this.regs[(address - 0x60) >> 1];
  }

  write16(address, value) {
    this.regs[(address - 0x60) >> 1] = value;
  }

  writeFifo8() {}

  usesTimer() {
    return false;
  }

  timerOverflow() {}

  event() {}
}
