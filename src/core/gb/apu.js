import { CLOCK_RATE } from './constants.js';

export const SAMPLE_RATE = 48000;

const DUTY_PATTERNS = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];
// Read-back masks for FF10-FF2F: unused and write-only bits read as 1.
const READ_MASKS = [
  0x80, 0x3f, 0x00, 0xff, 0xbf, // NR10-NR14
  0xff, 0x3f, 0x00, 0xff, 0xbf, // -, NR21-NR24
  0x7f, 0xff, 0x9f, 0xff, 0xbf, // NR30-NR34
  0xff, 0xff, 0x00, 0x00, 0xbf, // -, NR41-NR44
  0x00, 0x00, 0x70, // NR50-NR52
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];
// The output capacitor's charge factor per T-cycle, raised to the cycles per sample.
const HIGH_PASS = 0.999958 ** (CLOCK_RATE / SAMPLE_RATE);
// The wave channel runs at 2 MHz: the DMG's CPU reaches wave RAM only in the
// same 2-cycle tick as a fetch, and a retrigger in the tick before one
// corrupts it.
const WAVE_TICK = 2;

/** Length counter, volume envelope and DAC shared by the channels. */
class Channel {
  constructor(lengthMax) {
    this.lengthMax = lengthMax;
    this.reset();
  }

  reset() {
    this.enabled = false;
    this.dacOn = false;
    this.length = 0;
    this.lengthEnabled = false;
    this.frequency = 0;
    this.timer = 0;
    this.volume = 0;
    this.envelopeInitial = 0;
    this.envelopeUp = false;
    this.envelopePeriod = 0;
    this.envelopeTimer = 0;
  }

  sync(s) {
    for (const flag of ['enabled', 'dacOn', 'lengthEnabled', 'envelopeUp']) this[flag] = s.bool(this[flag]);
    for (const field of ['length', 'frequency', 'volume', 'envelopeInitial', 'envelopePeriod', 'envelopeTimer']) {
      this[field] = s.u16(this[field]);
    }
    this.timer = s.i32(this.timer);
  }

  clockLength() {
    if (this.lengthEnabled && this.length > 0 && --this.length === 0) this.enabled = false;
  }

  clockEnvelope() {
    if (!this.envelopePeriod || --this.envelopeTimer > 0) return;
    this.envelopeTimer = this.envelopePeriod;
    if (this.envelopeUp && this.volume < 15) this.volume++;
    else if (!this.envelopeUp && this.volume > 0) this.volume--;
  }

  /** NRx2: volume envelope; the top 5 bits all zero turn the DAC off. */
  writeEnvelope(value) {
    this.envelopeInitial = value >> 4;
    this.envelopeUp = (value & 0x08) !== 0;
    this.envelopePeriod = value & 7;
    this.dacOn = (value & 0xf8) !== 0;
    if (!this.dacOn) this.enabled = false;
  }

  /**
   * NRx4 length-enable and trigger handling, including the extra length clock
   * when the frame sequencer's next step doesn't clock lengths.
   */
  writeControl(value, lengthClockNext) {
    const wasEnabled = this.lengthEnabled;
    this.lengthEnabled = (value & 0x40) !== 0;
    if (!lengthClockNext && !wasEnabled && this.lengthEnabled && this.length > 0) {
      if (--this.length === 0 && !(value & 0x80)) this.enabled = false;
    }
    if (!(value & 0x80)) return false;
    if (this.length === 0) {
      this.length = this.lengthMax;
      if (this.lengthEnabled && !lengthClockNext) this.length--;
    }
    this.enabled = this.dacOn;
    this.volume = this.envelopeInitial;
    this.envelopeTimer = this.envelopePeriod;
    return true;
  }
}

class SquareChannel extends Channel {
  constructor(hasSweep) {
    super(64);
    this.hasSweep = hasSweep;
  }

  reset() {
    super.reset();
    this.duty = 0;
    this.dutyStep = 0;
    this.sweepPeriod = 0;
    this.sweepDown = false;
    this.sweepShift = 0;
    this.sweepTimer = 0;
    this.sweepEnabled = false;
    this.sweepFrequency = 0;
    // Set once a sweep calculation subtracts; clearing the negate bit afterwards disables the channel.
    this.sweepSubtracted = false;
  }

  sync(s) {
    super.sync(s);
    for (const field of ['duty', 'dutyStep', 'sweepPeriod', 'sweepShift', 'sweepTimer', 'sweepFrequency']) {
      this[field] = s.u16(this[field]);
    }
    for (const flag of ['sweepDown', 'sweepEnabled', 'sweepSubtracted']) this[flag] = s.bool(this[flag]);
  }

  get output() {
    return this.enabled && (DUTY_PATTERNS[this.duty] >> (7 - this.dutyStep)) & 1 ? this.volume : 0;
  }

  get period() {
    return (2048 - this.frequency) * 4;
  }

  step() {
    this.timer += this.period;
    this.dutyStep = (this.dutyStep + 1) & 7;
  }

  trigger() {
    this.timer = this.period;
    if (!this.hasSweep) return;
    this.sweepFrequency = this.frequency;
    this.sweepTimer = this.sweepPeriod || 8;
    this.sweepEnabled = this.sweepPeriod !== 0 || this.sweepShift !== 0;
    this.sweepSubtracted = false;
    if (this.sweepShift) this.#sweepTarget();
  }

  writeSweep(value) {
    this.sweepPeriod = (value >> 4) & 7;
    this.sweepDown = (value & 0x08) !== 0;
    this.sweepShift = value & 7;
    if (!this.sweepDown && this.sweepSubtracted) this.enabled = false;
  }

  /** Returns the new frequency, or -1 when the sweep didn't change it. */
  clockSweep() {
    if (--this.sweepTimer > 0) return -1;
    this.sweepTimer = this.sweepPeriod || 8;
    if (!this.sweepEnabled || !this.sweepPeriod) return -1;
    const target = this.#sweepTarget();
    if (target > 2047 || !this.sweepShift) return -1;
    this.sweepFrequency = target;
    this.frequency = target;
    this.#sweepTarget();
    return target;
  }

  #sweepTarget() {
    const delta = this.sweepFrequency >> this.sweepShift;
    let target = this.sweepFrequency + delta;
    if (this.sweepDown) {
      target = this.sweepFrequency - delta;
      this.sweepSubtracted = true;
    }
    if (target > 2047) this.enabled = false;
    return target;
  }
}

class WaveChannel extends Channel {
  constructor() {
    super(256);
    this.ram = new Uint8Array(16);
  }

  reset() {
    super.reset();
    this.position = 0;
    this.sample = 0;
    this.volumeShift = 4;
    // Whether wave RAM has been read since the trigger.
    this.fetched = false;
  }

  sync(s) {
    super.sync(s);
    this.position = s.u8(this.position);
    this.sample = s.u8(this.sample);
    this.volumeShift = s.u8(this.volumeShift);
    this.fetched = s.bool(this.fetched);
    s.bytes(this.ram);
  }

  get output() {
    return this.enabled ? this.sample >> this.volumeShift : 0;
  }

  get period() {
    return (2048 - this.frequency) * 2;
  }

  step() {
    this.timer += this.period;
    this.position = (this.position + 1) & 31;
    this.fetched = true;
    const byte = this.ram[this.position >> 1];
    this.sample = this.position & 1 ? byte & 0x0f : byte >> 4;
  }

  trigger() {
    this.position = 0;
    this.fetched = false;
    // The first sample is fetched a little after the trigger.
    this.timer = this.period + 6;
  }

  /** While playing, the CPU sees the byte the channel is reading. */
  ramIndex(addr) {
    return this.enabled ? this.position >> 1 : addr & 0x0f;
  }

  /**
   * The DMG's wave RAM is only reachable while playing in the cycle the
   * channel reads it; otherwise reads give FF and writes are lost.
   */
  get justRead() {
    return this.fetched && this.period - this.timer < WAVE_TICK;
  }

  /**
   * DMG: retriggering just before the channel reads wave RAM corrupts its
   * first bytes with the ones being read.
   */
  corruptOnTrigger() {
    if (!this.enabled || this.timer > WAVE_TICK) return;
    const offset = ((this.position + 1) >> 1) & 0x0f;
    if (offset < 4) this.ram[0] = this.ram[offset];
    else this.ram.copyWithin(0, offset & 0x0c, (offset & 0x0c) + 4);
  }
}

class NoiseChannel extends Channel {
  constructor() {
    super(64);
  }

  reset() {
    super.reset();
    this.lfsr = 0x7fff;
    this.shift = 0;
    this.narrow = false;
    this.divisor = 0;
  }

  sync(s) {
    super.sync(s);
    this.lfsr = s.u16(this.lfsr);
    this.shift = s.u8(this.shift);
    this.narrow = s.bool(this.narrow);
    this.divisor = s.u8(this.divisor);
  }

  get output() {
    return this.enabled && !(this.lfsr & 1) ? this.volume : 0;
  }

  get period() {
    // Shifts 14 and 15 stop the clock.
    return this.shift >= 14 ? 0x7fffffff : NOISE_DIVISORS[this.divisor] << this.shift;
  }

  step() {
    this.timer += this.period;
    const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
    this.lfsr = (this.lfsr >> 1) | (bit << 14);
    if (this.narrow) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
  }

  trigger() {
    this.timer = this.period;
    this.lfsr = 0x7fff;
  }

  writePolynomial(value) {
    this.shift = value >> 4;
    this.narrow = (value & 0x08) !== 0;
    this.divisor = value & 7;
    // Leaving a stopped clock (shift 14/15) shouldn't wait out the stopped period.
    if (this.timer > this.period) this.timer = this.period;
  }
}

/**
 * Audio processing unit: two square channels (the first with a frequency
 * sweep), a wave channel and a noise channel, mixed to stereo.
 *
 * Channels are emulated lazily (see catchUp()). The output is averaged over
 * each output sample period (a box filter against aliasing), then passed
 * through a high-pass filter that models the output capacitor removing DC.
 */
export class Apu {
  /** @param {import('./gameboy.js').GameBoy} gb */
  constructor(gb) {
    this.gb = gb;
    this.ch1 = new SquareChannel(true);
    this.ch2 = new SquareChannel(false);
    this.ch3 = new WaveChannel();
    this.ch4 = new NoiseChannel();
    this.regs = new Uint8Array(0x20);
    // Room for a frame of samples with margin (frames can run long while the LCD is off).
    this.buffer = new Float32Array(8192);
    this.reset();
  }

  reset() {
    for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) ch.reset();
    this.ch3.ram.fill(0);
    this.regs.fill(0);
    this.power = false;
    this.frameStep = 0;
    this.left = 0;
    this.right = 0;
    this.dirty = true;
    this.sumLeft = 0;
    this.sumRight = 0;
    this.sumCycles = 0;
    this.sampleClock = 0;
    this.capLeft = 0;
    this.capRight = 0;
    this.length = 0;
    // Cycles not emulated yet; see catchUp().
    this.pending = 0;
  }

  sync(s) {
    if (!s.reading) this.catchUp();
    this.pending = 0;
    for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) ch.sync(s);
    s.bytes(this.regs);
    this.power = s.bool(this.power);
    this.frameStep = s.u8(this.frameStep);
    for (const field of ['sumLeft', 'sumRight', 'capLeft', 'capRight']) this[field] = s.f64(this[field]);
    this.sumCycles = s.u32(this.sumCycles);
    this.sampleClock = s.u32(this.sampleClock);
    this.dirty = true;
  }

  /** Charges the output capacitor to the current level, so power-on doesn't thump. */
  settle() {
    this.#mix();
    this.capLeft = this.left;
    this.capRight = this.right;
  }

  /** Starts collecting the samples of a new video frame. */
  beginFrame() {
    this.length = 0;
  }

  get samples() {
    return this.buffer.subarray(0, this.length);
  }

  /** PCM12/PCM34 (CGB): current digital outputs of two channels. */
  readPcm(addr) {
    this.catchUp();
    return addr === 0xff76 ? (this.ch2.output << 4) | this.ch1.output : (this.ch4.output << 4) | this.ch3.output;
  }

  /**
   * Emulates the cycles accumulated in `pending` (T-cycles at normal speed).
   * Called before anything reads or changes APU state and at the end of each
   * frame; jumps from one channel step or output sample to the next instead
   * of stepping every cycle.
   */
  catchUp() {
    let cycles = this.pending;
    this.pending = 0;
    const { ch1, ch2, ch3, ch4 } = this;
    while (cycles > 0) {
      if (this.dirty) this.#mix();
      let step = Math.ceil((CLOCK_RATE - this.sampleClock) / SAMPLE_RATE);
      if (step > cycles) step = cycles;
      if (this.power) {
        if (ch1.enabled && ch1.timer < step) step = ch1.timer;
        if (ch2.enabled && ch2.timer < step) step = ch2.timer;
        if (ch3.enabled && ch3.timer < step) step = ch3.timer;
        if (ch4.enabled && ch4.timer < step) step = ch4.timer;
        if (step < 1) step = 1;
      }

      this.sumLeft += this.left * step;
      this.sumRight += this.right * step;
      this.sumCycles += step;
      this.sampleClock += step * SAMPLE_RATE;
      cycles -= step;

      if (this.power) {
        if (ch1.enabled && (ch1.timer -= step) <= 0) {
          do ch1.step(); while (ch1.timer <= 0);
          this.dirty = true;
        }
        if (ch2.enabled && (ch2.timer -= step) <= 0) {
          do ch2.step(); while (ch2.timer <= 0);
          this.dirty = true;
        }
        if (ch3.enabled && (ch3.timer -= step) <= 0) {
          do ch3.step(); while (ch3.timer <= 0);
          this.dirty = true;
        }
        if (ch4.enabled && (ch4.timer -= step) <= 0) {
          do ch4.step(); while (ch4.timer <= 0);
          this.dirty = true;
        }
      }
      if (this.sampleClock >= CLOCK_RATE) {
        this.sampleClock -= CLOCK_RATE;
        this.#emit();
      }
    }
  }

  #emit() {
    const left = this.sumLeft / this.sumCycles;
    const right = this.sumRight / this.sumCycles;
    this.sumLeft = this.sumRight = this.sumCycles = 0;
    const outLeft = left - this.capLeft;
    const outRight = right - this.capRight;
    this.capLeft = left - outLeft * HIGH_PASS;
    this.capRight = right - outRight * HIGH_PASS;
    if (this.length + 2 <= this.buffer.length) {
      this.buffer[this.length++] = outLeft;
      this.buffer[this.length++] = outRight;
    }
  }

  #mix() {
    this.dirty = false;
    const panning = this.regs[0x15];
    let left = 0;
    let right = 0;
    // The DACs map 0-15 to an analog level between -1 and 1.
    if (this.ch1.dacOn) {
      const level = this.ch1.output / 7.5 - 1;
      if (panning & 0x10) left += level;
      if (panning & 0x01) right += level;
    }
    if (this.ch2.dacOn) {
      const level = this.ch2.output / 7.5 - 1;
      if (panning & 0x20) left += level;
      if (panning & 0x02) right += level;
    }
    if (this.ch3.dacOn) {
      const level = this.ch3.output / 7.5 - 1;
      if (panning & 0x40) left += level;
      if (panning & 0x04) right += level;
    }
    if (this.ch4.dacOn) {
      const level = this.ch4.output / 7.5 - 1;
      if (panning & 0x80) left += level;
      if (panning & 0x08) right += level;
    }
    // Master volume (1-8) / 8, and / 4 channels: everything at full volume reaches ±1.
    const volume = this.regs[0x14];
    this.left = (left * (((volume >> 4) & 7) + 1)) / 32;
    this.right = (right * ((volume & 7) + 1)) / 32;
  }

  /** 512 Hz, from a falling edge of DIV bit 4 (bit 5 in double speed). */
  clockFrameSequencer() {
    if (!this.power) return;
    this.catchUp();
    const step = this.frameStep;
    this.frameStep = (step + 1) & 7;
    if (!(step & 1)) {
      this.ch1.clockLength();
      this.ch2.clockLength();
      this.ch3.clockLength();
      this.ch4.clockLength();
    }
    if (step === 2 || step === 6) {
      const frequency = this.ch1.clockSweep();
      if (frequency >= 0) {
        this.regs[0x03] = frequency & 0xff;
        this.regs[0x04] = (this.regs[0x04] & 0xf8) | (frequency >> 8);
      }
    }
    if (step === 7) {
      this.ch1.clockEnvelope();
      this.ch2.clockEnvelope();
      this.ch4.clockEnvelope();
    }
    this.dirty = true;
  }

  read(addr) {
    this.catchUp();
    if (addr >= 0xff30) {
      const ch3 = this.ch3;
      if (ch3.enabled && !this.gb.cgb && !ch3.justRead) return 0xff;
      return ch3.ram[ch3.ramIndex(addr)];
    }
    const i = addr - 0xff10;
    if (addr === 0xff26) {
      return 0x70 | (this.power ? 0x80 : 0) | (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) |
        (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
    }
    return this.regs[i] | READ_MASKS[i];
  }

  write(addr, value) {
    this.catchUp();
    if (addr >= 0xff30) {
      const ch3 = this.ch3;
      if (ch3.enabled && !this.gb.cgb && !ch3.justRead) return;
      ch3.ram[ch3.ramIndex(addr)] = value;
      return;
    }
    if (addr === 0xff26) {
      this.#writePower(value);
      return;
    }
    const i = addr - 0xff10;
    if (!this.power) {
      // Powered off, only the DMG's length counters can be written.
      if (this.gb.cgb) return;
      if (addr === 0xff11 || addr === 0xff16 || addr === 0xff20) value &= 0x3f;
      else if (addr !== 0xff1b) return;
    }
    if (i >= 0x17) return;
    this.regs[i] = value;
    this.dirty = true;
    // Lengths are clocked on even steps; frameStep is the next step to run.
    const lengthClockNext = (this.frameStep & 1) === 0;
    const { ch1, ch2, ch3, ch4 } = this;
    switch (addr) {
      case 0xff10: ch1.writeSweep(value); break;
      case 0xff11: ch1.duty = value >> 6; ch1.length = 64 - (value & 0x3f); break;
      case 0xff12: ch1.writeEnvelope(value); break;
      case 0xff13: ch1.frequency = (ch1.frequency & 0x700) | value; break;
      case 0xff14:
        ch1.frequency = (ch1.frequency & 0xff) | ((value & 7) << 8);
        if (ch1.writeControl(value, lengthClockNext)) ch1.trigger();
        break;
      case 0xff16: ch2.duty = value >> 6; ch2.length = 64 - (value & 0x3f); break;
      case 0xff17: ch2.writeEnvelope(value); break;
      case 0xff18: ch2.frequency = (ch2.frequency & 0x700) | value; break;
      case 0xff19:
        ch2.frequency = (ch2.frequency & 0xff) | ((value & 7) << 8);
        if (ch2.writeControl(value, lengthClockNext)) ch2.trigger();
        break;
      case 0xff1a:
        ch3.dacOn = (value & 0x80) !== 0;
        if (!ch3.dacOn) ch3.enabled = false;
        break;
      case 0xff1b: ch3.length = 256 - value; break;
      case 0xff1c: ch3.volumeShift = [4, 0, 1, 2][(value >> 5) & 3]; break;
      case 0xff1d: ch3.frequency = (ch3.frequency & 0x700) | value; break;
      case 0xff1e:
        ch3.frequency = (ch3.frequency & 0xff) | ((value & 7) << 8);
        if (value & 0x80 && !this.gb.cgb) ch3.corruptOnTrigger();
        if (ch3.writeControl(value, lengthClockNext)) ch3.trigger();
        break;
      case 0xff20: ch4.length = 64 - (value & 0x3f); break;
      case 0xff21: ch4.writeEnvelope(value); break;
      case 0xff22: ch4.writePolynomial(value); break;
      case 0xff23:
        if (ch4.writeControl(value, lengthClockNext)) ch4.trigger();
        break;
    }
  }

  #writePower(value) {
    const on = (value & 0x80) !== 0;
    if (on === this.power) return;
    this.power = on;
    if (!on) {
      // Powering off clears every register; the DMG keeps the length counters.
      const lengths = [this.ch1.length, this.ch2.length, this.ch3.length, this.ch4.length];
      for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) ch.reset();
      if (!this.gb.cgb) [this.ch1.length, this.ch2.length, this.ch3.length, this.ch4.length] = lengths;
      this.regs.fill(0);
    } else {
      this.frameStep = 0;
    }
    this.dirty = true;
  }
}
