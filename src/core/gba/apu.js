import { NoiseChannel, SquareChannel, WaveChannel } from "../gb/channels.js";

export const SAMPLE_RATE = 48000;
const CLOCK_RATE = 16777216;
// The Game Boy channels run at a quarter of the CPU clock.
const PSG_DIVIDER = 4;
// 512 Hz: lengths, sweep and envelopes.
const FRAME_SEQUENCER_PERIOD = 32768;
// The output capacitor, as on the Game Boy (per 4 MHz cycle, raised to a sample).
const HIGH_PASS = 0.999958 ** (CLOCK_RATE / PSG_DIVIDER / SAMPLE_RATE);
const FIFO_A = 0x040000a0;
const FIFO_B = 0x040000a4;
// Read-back masks of 0x60-0x8F per byte (write-only and unused bits read 0).
const READ_MASKS = [
    0x7f, 0x00, 0xc0, 0xff, 0x00, 0x40, 0x00, 0x00, // SOUND1CNT
    0xc0, 0xff, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, // SOUND2CNT
    0xe0, 0x00, 0x00, 0xe0, 0x00, 0x40, 0x00, 0x00, // SOUND3CNT
    0x00, 0xff, 0x00, 0x00, 0xff, 0x40, 0x00, 0x00, // SOUND4CNT
    0x77, 0xff, 0x0f, 0x77, 0x80, 0x00, 0x00, 0x00, // SOUNDCNT_L/H/X
    0xff, 0xc3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // SOUNDBIAS
];

const period4 = (period) => (period >= 0x7fffffff ? period : period * PSG_DIVIDER);

class GbaSquareChannel extends SquareChannel {
    get period() {
        return period4(super.period);
    }
}

class GbaNoiseChannel extends NoiseChannel {
    get period() {
        return period4(super.period);
    }
}

/** The wave channel with two banks of wave RAM, which can play as one. */
class GbaWaveChannel extends WaveChannel {
    constructor() {
        super();
        this.ram = new Uint8Array(32);
    }

    reset() {
        super.reset();
        this.bank = 0;
        this.doubleBank = false;
        this.level = 0;
    }

    sync(s) {
        super.sync(s);
        this.bank = s.u8(this.bank);
        this.doubleBank = s.bool(this.doubleBank);
        this.level = s.f64(this.level);
    }

    get period() {
        return super.period * PSG_DIVIDER;
    }

    get output() {
        return this.enabled ? this.sample * this.level : 0;
    }

    step() {
        this.timer += this.period;
        this.position = (this.position + 1) & (this.doubleBank ? 63 : 31);
        const bank = this.bank ^ (this.position >> 5);
        const byte = this.ram[bank * 16 + ((this.position & 31) >> 1)];
        this.sample = this.position & 1 ? byte & 0x0f : byte >> 4;
    }

    /** SOUND3CNT_H's volume: mute, 100%, 50%, 25%, or 75% (bit 7). */
    writeVolume(value) {
        this.level = value & 0x80 ? 0.75 : [0, 1, 0.5, 0.25][(value >> 5) & 3];
    }
}

/** A Direct Sound FIFO: 32 signed 8-bit samples, played one per timer overflow. */
class Fifo {
    constructor() {
        this.data = new Int8Array(32);
        this.reset();
    }

    reset() {
        this.data.fill(0);
        this.head = 0;
        this.count = 0;
        this.sample = 0;
    }

    sync(s) {
        s.bytes(this.data);
        this.head = s.u8(this.head);
        this.count = s.u8(this.count);
        this.sample = s.i32(this.sample);
    }

    push(byte) {
        if (this.count === 32) return;
        this.data[(this.head + this.count) & 31] = byte;
        this.count++;
    }

    /** Plays the next sample (an empty FIFO keeps the last one). */
    pop() {
        if (!this.count) return;
        this.sample = this.data[this.head];
        this.head = (this.head + 1) & 31;
        this.count--;
    }
}

/**
 * Sound: the Game Boy's four channels (on a quarter clock, with a two-bank
 * wave channel) and the two Direct Sound FIFOs, which play 8-bit samples at
 * the rate of a timer and are refilled by DMA 1/2. Mixed like the hardware
 * (10-bit range around SOUNDBIAS), then averaged per output sample and
 * high-pass filtered like the Game Boy core.
 *
 * Emulated lazily: catchUp() runs up to now before register accesses, FIFO
 * samples and at the end of the frame.
 */
export class Apu {
    /**
     * @param {{ now: () => number, requestFifo: (address: number) => void, onTimerChange: () => void }} hooks
     */
    constructor(hooks) {
        this.hooks = hooks;
        this.ch1 = new GbaSquareChannel(true);
        this.ch2 = new GbaSquareChannel(false);
        this.ch3 = new GbaWaveChannel();
        this.ch4 = new GbaNoiseChannel();
        this.fifoA = new Fifo();
        this.fifoB = new Fifo();
        // Registers 0x60-0x8F as written.
        this.regs = new Uint8Array(0x30);
        this.buffer = new Float32Array(8192);
        this.nextEvent = Infinity;
        this.reset();
    }

    reset() {
        for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) ch.reset();
        this.ch3.ram.fill(0);
        this.fifoA.reset();
        this.fifoB.reset();
        this.regs.fill(0);
        this.regs[0x28] = 0x00;
        this.regs[0x29] = 0x02; // SOUNDBIAS 0x200
        this.time = this.hooks.now();
        this.sequencerTimer = FRAME_SEQUENCER_PERIOD;
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
    }

    sync(s) {
        if (!s.reading) this.catchUp();
        for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) ch.sync(s);
        this.fifoA.sync(s);
        this.fifoB.sync(s);
        s.bytes(this.regs);
        this.time = s.f64(this.time);
        this.sequencerTimer = s.u32(this.sequencerTimer);
        this.frameStep = s.u8(this.frameStep);
        for (const field of ["sumLeft", "sumRight", "capLeft", "capRight"]) this[field] = s.f64(this[field]);
        this.sumCycles = s.u32(this.sumCycles);
        this.sampleClock = s.u32(this.sampleClock);
        this.dirty = true;
    }

    get enabled() {
        return (this.regs[0x24] & 0x80) !== 0;
    }

    get #control() {
        return this.regs[0x22] | (this.regs[0x23] << 8);
    }

    get samples() {
        return this.buffer.subarray(0, this.length);
    }

    beginFrame() {
        this.length = 0;
    }

    endFrame() {
        this.catchUp();
    }

    event() {}

    // --- Direct Sound ---------------------------------------------------------------

    /** Whether timer 0 or 1 clocks a FIFO (so the timer must report overflows). */
    usesTimer(timer) {
        if (!this.enabled) return false;
        const control = this.#control;
        return (control & 0x0300 && ((control >> 10) & 1) === timer) || (control & 0x3000 && ((control >> 14) & 1) === timer);
    }

    timerOverflow(timer, time) {
        if (!this.enabled) return;
        const control = this.#control;
        const a = control & 0x0300 && ((control >> 10) & 1) === timer;
        const b = control & 0x3000 && ((control >> 14) & 1) === timer;
        if (!a && !b) return;
        this.catchUp(time);
        if (a) this.#play(this.fifoA, FIFO_A);
        if (b) this.#play(this.fifoB, FIFO_B);
    }

    #play(fifo, address) {
        fifo.pop();
        this.dirty = true;
        // Half empty: DMA refills it.
        if (fifo.count <= 16) this.hooks.requestFifo(address);
    }

    // --- Registers --------------------------------------------------------------------

    read16(address) {
        return this.read8(address) | (this.read8(address + 1) << 8);
    }

    read8(address) {
        if (address >= 0x90) {
            // The CPU sees the bank that isn't playing.
            const ch3 = this.ch3;
            return ch3.ram[(ch3.bank ^ 1) * 16 + (address & 0x0f)];
        }
        const i = address - 0x60;
        if (address === 0x84) {
            this.catchUp();
            return (this.regs[i] & 0x80) | (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) |
                (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
        }
        return this.regs[i] & READ_MASKS[i];
    }

    write16(address, value) {
        this.write8(address, value & 0xff);
        this.write8(address + 1, value >>> 8);
    }

    write8(address, value) {
        if (address >= 0xa0) {
            (address < 0xa4 ? this.fifoA : this.fifoB).push(value);
            return;
        }
        this.catchUp();
        if (address >= 0x90) {
            const ch3 = this.ch3;
            ch3.ram[(ch3.bank ^ 1) * 16 + (address & 0x0f)] = value;
            return;
        }
        const i = address - 0x60;
        if (address < 0x82 && !this.enabled) return;
        this.dirty = true;
        switch (address) {
            case 0x82:
                this.regs[i] = value;
                break;
            case 0x83:
                if (value & 0x08) this.fifoA.reset();
                if (value & 0x80) this.fifoB.reset();
                this.regs[i] = value & 0x77;
                this.hooks.onTimerChange();
                break;
            case 0x84: this.#writeEnable(value); break;
            case 0x88: case 0x89: this.regs[i] = value; break;
            default:
                if (address < 0x82) this.#writePsg(address, value);
        }
    }

    #writePsg(address, value) {
        this.regs[address - 0x60] = value;
        // Lengths are clocked on even steps; frameStep is the next step to run.
        const lengthClockNext = (this.frameStep & 1) === 0;
        const { ch1, ch2, ch3, ch4 } = this;
        switch (address) {
            case 0x60: ch1.writeSweep(value); break;
            case 0x62: ch1.duty = value >> 6; ch1.length = 64 - (value & 0x3f); break;
            case 0x63: ch1.writeEnvelope(value); break;
            case 0x64: ch1.frequency = (ch1.frequency & 0x700) | value; break;
            case 0x65:
                ch1.frequency = (ch1.frequency & 0xff) | ((value & 7) << 8);
                if (ch1.writeControl(value, lengthClockNext)) ch1.trigger();
                break;
            case 0x68: ch2.duty = value >> 6; ch2.length = 64 - (value & 0x3f); break;
            case 0x69: ch2.writeEnvelope(value); break;
            case 0x6c: ch2.frequency = (ch2.frequency & 0x700) | value; break;
            case 0x6d:
                ch2.frequency = (ch2.frequency & 0xff) | ((value & 7) << 8);
                if (ch2.writeControl(value, lengthClockNext)) ch2.trigger();
                break;
            case 0x70:
                ch3.doubleBank = (value & 0x20) !== 0;
                ch3.bank = (value >> 6) & 1;
                ch3.dacOn = (value & 0x80) !== 0;
                if (!ch3.dacOn) ch3.enabled = false;
                break;
            case 0x72: ch3.length = 256 - value; break;
            case 0x73: ch3.writeVolume(value); break;
            case 0x74: ch3.frequency = (ch3.frequency & 0x700) | value; break;
            case 0x75:
                ch3.frequency = (ch3.frequency & 0xff) | ((value & 7) << 8);
                if (ch3.writeControl(value, lengthClockNext)) ch3.trigger();
                break;
            case 0x78: ch4.length = 64 - (value & 0x3f); break;
            case 0x79: ch4.writeEnvelope(value); break;
            case 0x7c: ch4.writePolynomial(value); break;
            case 0x7d:
                if (ch4.writeControl(value, lengthClockNext)) ch4.trigger();
                break;
        }
    }

    /** SOUNDCNT_X: master enable; turning it off clears the Game Boy channels. */
    #writeEnable(value) {
        const on = (value & 0x80) !== 0;
        if (on !== this.enabled && !on) {
            for (const ch of [this.ch1, this.ch2, this.ch3, this.ch4]) ch.reset();
            this.regs.fill(0, 0, 0x22);
        } else if (on !== this.enabled) {
            this.frameStep = 0;
        }
        this.regs[0x24] = value & 0x80;
        this.hooks.onTimerChange();
    }

    // --- Output -----------------------------------------------------------------------

    /** Runs the channels and the output up to `now` (CPU cycles). */
    catchUp(now = this.hooks.now()) {
        let cycles = now - this.time;
        if (cycles <= 0) return;
        this.time = now;
        const { ch1, ch2, ch3, ch4 } = this;
        const on = this.enabled;
        while (cycles > 0) {
            if (this.dirty) this.#mix();
            let step = Math.ceil((CLOCK_RATE - this.sampleClock) / SAMPLE_RATE);
            if (step > cycles) step = cycles;
            if (on) {
                if (this.sequencerTimer < step) step = this.sequencerTimer;
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

            if (on) {
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
                if ((this.sequencerTimer -= step) <= 0) {
                    this.sequencerTimer += FRAME_SEQUENCER_PERIOD;
                    this.#clockFrameSequencer();
                }
            }
            if (this.sampleClock >= CLOCK_RATE) {
                this.sampleClock -= CLOCK_RATE;
                this.#emit();
            }
        }
    }

    #clockFrameSequencer() {
        const step = this.frameStep;
        this.frameStep = (step + 1) & 7;
        if (!(step & 1)) {
            this.ch1.clockLength();
            this.ch2.clockLength();
            this.ch3.clockLength();
            this.ch4.clockLength();
        }
        if (step === 2 || step === 6) this.ch1.clockSweep();
        if (step === 7) {
            this.ch1.clockEnvelope();
            this.ch2.clockEnvelope();
            this.ch4.clockEnvelope();
        }
        this.dirty = true;
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

    /**
     * The hardware mix: the Game Boy channels (0-15 each, times the master
     * volume 1-8, at 25/50/100%) plus the FIFOs (±128 times 2 or 4), clipped
     * to 10 bits around the bias; scaled so the range is ±1.
     */
    #mix() {
        this.dirty = false;
        if (!this.enabled) {
            this.left = this.right = 0;
            return;
        }
        const regs = this.regs;
        const panning = regs[0x21];
        const outputs = [this.ch1.output, this.ch2.output, this.ch3.output, this.ch4.output];
        let left = 0;
        let right = 0;
        for (let i = 0; i < 4; i++) {
            if (panning & (0x10 << i)) left += outputs[i];
            if (panning & (0x01 << i)) right += outputs[i];
        }
        const control = this.#control;
        const psg = [0.25, 0.5, 1, 1][control & 3];
        left *= (((regs[0x20] >> 4) & 7) + 1) * psg;
        right *= ((regs[0x20] & 7) + 1) * psg;
        const a = this.fifoA.sample * (control & 4 ? 4 : 2);
        const b = this.fifoB.sample * (control & 8 ? 4 : 2);
        if (control & 0x0200) left += a;
        if (control & 0x0100) right += a;
        if (control & 0x2000) left += b;
        if (control & 0x1000) right += b;
        const bias = (regs[0x28] | (regs[0x29] << 8)) & 0x3fe;
        this.left = (Math.min(Math.max(left + bias, 0), 0x3ff) - bias) / 512;
        this.right = (Math.min(Math.max(right + bias, 0), 0x3ff) - bias) / 512;
    }
}
