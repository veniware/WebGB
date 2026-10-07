/*
 * The Game Boy's APU, clocked like the hardware at 2 MHz. Channel timing,
 * start delays and glitches are ported from SameBoy's Core/apu.c (reduced to
 * the DMG and CGB-E; the output stage is WebGB's own). SameBoy's license:
 *
 * Copyright (c) 2015-2026 Lior Halphon
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { CLOCK_RATE } from "./constants.js";
import { NoiseChannel, SquareChannel, WaveChannel } from "./channels.js";

export const SAMPLE_RATE = 48000;

// APU cycles per second (2 MHz: two per M-cycle at normal speed, one in double speed).
const APU_RATE = CLOCK_RATE / 2;
// The output capacitor's charge factor per T-cycle, raised to the cycles per sample.
const HIGH_PASS = 0.999958 ** (CLOCK_RATE / SAMPLE_RATE);

const DUTIES = [
    0, 0, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 1, 1, 1,
    0, 1, 1, 1, 1, 1, 1, 0,
];

// Read-back masks for FF10-FF2F: unused and write-only bits read as 1.
const READ_MASKS = [
    0x80, 0x3f, 0x00, 0xff, 0xbf, // NR10-NR14
    0xff, 0x3f, 0x00, 0xff, 0xbf, // -, NR21-NR24
    0x7f, 0xff, 0x9f, 0xff, 0xbf, // NR30-NR34
    0xff, 0xff, 0x00, 0x00, 0xbf, // -, NR41-NR44
    0x00, 0x00, 0x70, // NR50-NR52
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

// Register offsets from FF10.
const NR10 = 0x00, NR11 = 0x01, NR12 = 0x02, NR13 = 0x03, NR14 = 0x04;
const NR21 = 0x06, NR22 = 0x07, NR23 = 0x08, NR24 = 0x09;
const NR30 = 0x0a, NR31 = 0x0b, NR32 = 0x0c, NR33 = 0x0d, NR34 = 0x0e;
const NR41 = 0x10, NR42 = 0x11, NR43 = 0x12, NR44 = 0x13;
const NR50 = 0x14, NR51 = 0x15, NR52 = 0x16, WAVE_RAM = 0x20;

const SQUARE_1 = 0, SQUARE_2 = 1, WAVE = 2, NOISE = 3;

// Skipping the first DIV event after power-on (see #init).
const SKIP_INACTIVE = 0, SKIPPED = 1, SKIP = 2;

// The format of save states before this APU (GameBoy.version 4).
const OLD_STATE_VERSION = 4;

/** An envelope's clock and lock (it stops at volume 0 or 15). */
class Envelope {
    clock = false;
    locked = false;
    shouldLock = false;

    set(value, up, volume) {
        if (this.clock === value) return;
        if (value) {
            this.clock = true;
            this.shouldLock = (volume === 0xf && up) || (volume === 0 && !up);
        } else {
            this.clock = false;
            this.locked ||= this.shouldLock;
        }
    }

    sync(s) {
        this.clock = s.bool(this.clock);
        this.locked = s.bool(this.locked);
        this.shouldLock = s.bool(this.shouldLock);
    }
}

class Square {
    constructor() {
        this.envelope = new Envelope();
        this.reset();
    }

    reset() {
        this.pulseLength = 0; // in 256 Hz ticks
        this.currentVolume = 0;
        this.volumeCountdown = 0;
        this.currentSampleIndex = 0;
        this.sampleSurpressed = false;
        this.sampleCountdown = 0xffff; // in APU cycles
        this.sampleLength = 0; // NRx3, NRx4
        this.lengthEnabled = false;
        this.delay = 0;
        this.didTick = false;
        this.justReloaded = false;
        this.envelope.clock = this.envelope.locked = this.envelope.shouldLock = false;
    }

    sync(s) {
        this.pulseLength = s.u16(this.pulseLength);
        this.currentVolume = s.u8(this.currentVolume);
        this.volumeCountdown = s.u8(this.volumeCountdown);
        this.currentSampleIndex = s.u8(this.currentSampleIndex);
        this.sampleSurpressed = s.bool(this.sampleSurpressed);
        this.sampleCountdown = s.u16(this.sampleCountdown);
        this.sampleLength = s.u16(this.sampleLength);
        this.lengthEnabled = s.bool(this.lengthEnabled);
        this.delay = s.u8(this.delay);
        this.didTick = s.bool(this.didTick);
        this.justReloaded = s.bool(this.justReloaded);
        this.envelope.sync(s);
    }
}

class Wave {
    constructor() {
        this.reset();
    }

    reset() {
        this.enable = false; // NR30
        this.pulseLength = 0;
        this.shift = 4; // NR32
        this.sampleLength = 0;
        this.lengthEnabled = false;
        this.sampleCountdown = 0;
        this.currentSampleIndex = 0;
        this.currentSampleByte = 0;
        this.waveFormJustRead = false;
        this.pulsed = false;
        this.buggedReadCountdown = 0;
    }

    sync(s) {
        this.enable = s.bool(this.enable);
        this.pulseLength = s.u16(this.pulseLength);
        this.shift = s.u8(this.shift);
        this.sampleLength = s.u16(this.sampleLength);
        this.lengthEnabled = s.bool(this.lengthEnabled);
        this.sampleCountdown = s.u16(this.sampleCountdown);
        this.currentSampleIndex = s.u8(this.currentSampleIndex);
        this.currentSampleByte = s.u8(this.currentSampleByte);
        this.waveFormJustRead = s.bool(this.waveFormJustRead);
        this.pulsed = s.bool(this.pulsed);
        this.buggedReadCountdown = s.u8(this.buggedReadCountdown);
    }
}

class Noise {
    constructor() {
        this.envelope = new Envelope();
        this.reset();
    }

    reset() {
        this.pulseLength = 0;
        this.currentVolume = 0;
        this.volumeCountdown = 0;
        this.lfsr = 0;
        this.narrow = false;
        this.counterCountdown = 0; // 2 MHz cycles to the next counter tick
        this.counter = 0; // 14 bits; a bit of it (NR43) clocks the LFSR
        this.lengthEnabled = false;
        this.alignment = 0;
        this.currentLfsrSample = false;
        this.didStepCounter = false;
        this.countdownReloaded = false;
        this.dmgDelayedStart = 0;
        this.envelope.clock = this.envelope.locked = this.envelope.shouldLock = false;
    }

    sync(s) {
        this.pulseLength = s.u16(this.pulseLength);
        this.currentVolume = s.u8(this.currentVolume);
        this.volumeCountdown = s.u8(this.volumeCountdown);
        this.lfsr = s.u16(this.lfsr);
        this.narrow = s.bool(this.narrow);
        this.counterCountdown = s.u8(this.counterCountdown);
        this.counter = s.u16(this.counter);
        this.lengthEnabled = s.bool(this.lengthEnabled);
        this.alignment = s.u8(this.alignment);
        this.currentLfsrSample = s.bool(this.currentLfsrSample);
        this.didStepCounter = s.bool(this.didStepCounter);
        this.countdownReloaded = s.bool(this.countdownReloaded);
        this.dmgDelayedStart = s.u8(this.dmgDelayedStart);
        this.envelope.sync(s);
    }
}

/**
 * Audio processing unit: two square channels (the first with a frequency
 * sweep), a wave channel and a noise channel, mixed to stereo.
 *
 * Emulated lazily: `pending` collects T-cycles (at normal speed) and
 * catchUp() runs the channels before anything reads or changes their state,
 * at each DIV event and at the end of a frame. Each channel's level is
 * averaged over an output sample (a box filter against aliasing), then a
 * high-pass filter models the output capacitor removing DC.
 */
export class Apu {
    /** @param {import("./gameboy.js").GameBoy} gb */
    constructor(gb) {
        this.gb = gb;
        this.square = [new Square(), new Square()];
        this.wave = new Wave();
        this.noise = new Noise();
        // FF10-FF3F (wave RAM at FF30).
        this.regs = new Uint8Array(0x30);
        // Each channel's digital output (0-15).
        this.channelSamples = new Uint8Array(4);
        this.isActive = [false, false, false, false];
        // Output: each channel's level and its sum over the current output sample.
        this.level = new Float64Array(4);
        this.area = new Float64Array(4);
        this.areaTime = new Float64Array(4);
        this.mixLeft = 0;
        this.mixRight = 0;
        // Room for a frame of samples with margin (frames can run long while the LCD is off).
        this.buffer = new Float32Array(8192);
        // Set while a DIV write resets the counter (a sweep timing hack, as in SameBoy).
        this.duringDivWrite = false;
        this.reset();
    }

    reset() {
        this.regs.fill(0);
        this.sampleClock = 0;
        // Cycles since the current output sample started, and where the current run started.
        this.windowTime = 0;
        this.chunkStart = 0;
        this.area.fill(0);
        this.areaTime.fill(0);
        this.#clear();
        this.lfDiv = 1;
        this.capLeft = 0;
        this.capRight = 0;
        this.length = 0;
        // T-cycles not emulated yet; see catchUp().
        this.pending = 0;
    }

    /** Everything the APU loses when it's powered off. */
    #clear() {
        this.power = false;
        this.channelSamples.fill(0);
        this.isActive.fill(false);
        this.divDivider = 0;
        this.lfDiv = 0;
        this.sweepCountdown = 0; // 128 Hz
        this.sweepCalcCountdown = 0; // 1 MHz
        this.sweepReloadTimer = 0; // 1 MHz
        this.sweepLengthAddend = 0;
        this.shadowSweepSampleLength = 0;
        this.unshiftedSweep = false;
        this.sweepInstantDone = false;
        this.ch1RestartHold = 0;
        this.ch1CompletedAddend = 0;
        for (const square of this.square) square.reset();
        this.wave.reset();
        this.wave.shift = 0;
        this.noise.reset();
        this.skipDivEvent = SKIP_INACTIVE;
        this.pendingEnvelopeTick = false;
        this.noiseCounterActive = false;
        this.noiseBackgroundCounterActive = false;
        this.lfsrSteppedInNarrow = false;
        this.lfsrBit7BeforeStep = false;
        this.noiseStartedWithDacDisabled = false;
        for (let i = 0; i < 4; i++) this.#refreshLevel(i);
    }

    /** At power-on (GB_apu_init). */
    #init() {
        this.#clear();
        this.lfDiv = 1;
        this.wave.shift = 4;
        // Powering on while DIV's APU bit is set skips the first DIV event.
        if (this.gb.timer.counter & (this.gb.doubleSpeed ? 0x2000 : 0x1000)) {
            this.skipDivEvent = SKIP;
            this.divDivider = 1;
        }
        this.square[0].sampleCountdown = 0xffff;
        this.square[1].sampleCountdown = 0xffff;
    }

    sync(s) {
        if (!s.reading) this.catchUp();
        this.pending = 0;
        if (s.reading && s.version === OLD_STATE_VERSION) {
            this.#syncOld(s);
            return;
        }
        s.bytes(this.regs);
        s.bytes(this.channelSamples);
        for (let i = 0; i < 4; i++) this.isActive[i] = s.bool(this.isActive[i]);
        this.power = s.bool(this.power);
        for (const field of ["divDivider", "lfDiv", "sweepCountdown", "sweepCalcCountdown", "sweepReloadTimer",
            "ch1RestartHold", "skipDivEvent"]) {
            this[field] = s.u8(this[field]);
        }
        for (const field of ["sweepLengthAddend", "shadowSweepSampleLength", "ch1CompletedAddend"]) this[field] = s.u16(this[field]);
        for (const flag of ["unshiftedSweep", "sweepInstantDone", "pendingEnvelopeTick", "noiseCounterActive",
            "noiseBackgroundCounterActive", "lfsrSteppedInNarrow", "lfsrBit7BeforeStep", "noiseStartedWithDacDisabled"]) {
            this[flag] = s.bool(this[flag]);
        }
        for (const square of this.square) square.sync(s);
        this.wave.sync(s);
        this.noise.sync(s);
        this.capLeft = s.f64(this.capLeft);
        this.capRight = s.f64(this.capRight);
        this.sampleClock = s.u32(this.sampleClock);
        // The output sample in progress.
        this.windowTime = s.u32(this.windowTime);
        for (let i = 0; i < 4; i++) {
            this.area[i] = s.f64(this.area[i]);
            this.areaTime[i] = s.f64(this.areaTime[i]);
        }
        if (s.reading) {
            this.chunkStart = this.windowTime;
            for (let i = 0; i < 4; i++) this.level[i] = this.#dacEnabled(i) ? this.channelSamples[i] / 7.5 - 1 : 0;
        }
    }

    /** Reads the APU state of older save states (channels.js's model) and carries it over. */
    #syncOld(s) {
        const old = [new SquareChannel(true), new SquareChannel(false), new WaveChannel(), new NoiseChannel()];
        for (const ch of old) ch.sync(s);
        const regs = new Uint8Array(0x20);
        s.bytes(regs);
        const power = s.bool(false);
        const frameStep = s.u8(0);
        for (let i = 0; i < 4; i++) s.f64(0); // filter state
        s.u32(0);
        this.sampleClock = s.u32(0);
        this.#clear();
        this.power = power;
        this.lfDiv = 1;
        this.divDivider = frameStep;
        this.regs.set(regs.subarray(0, 0x17));
        this.regs.set(old[2].ram, WAVE_RAM);
        for (let i = 0; i < 2; i++) {
            const ch = old[i];
            const square = this.square[i];
            this.isActive[i] = ch.enabled;
            square.currentVolume = ch.volume;
            square.volumeCountdown = ch.envelopeTimer & 7;
            square.currentSampleIndex = ch.dutyStep;
            square.sampleLength = ch.frequency;
            square.sampleCountdown = Math.max(0, Math.min(0xffff, (ch.timer >> 1) - 1));
            square.pulseLength = ch.length;
            square.lengthEnabled = ch.lengthEnabled;
            this.channelSamples[i] = ch.output;
        }
        const [, , wave, noise] = old;
        this.wave.enable = wave.dacOn;
        this.wave.pulsed = wave.enabled;
        this.isActive[WAVE] = wave.enabled;
        this.wave.shift = wave.volumeShift;
        this.wave.sampleLength = wave.frequency;
        this.wave.sampleCountdown = Math.max(0, Math.min(0xffff, (wave.timer >> 1) - 1));
        this.wave.currentSampleIndex = wave.position;
        this.wave.currentSampleByte = wave.ram[wave.position >> 1];
        this.wave.pulseLength = wave.length;
        this.wave.lengthEnabled = wave.lengthEnabled;
        this.channelSamples[WAVE] = wave.output;
        this.isActive[NOISE] = noise.enabled;
        this.noise.currentVolume = noise.volume;
        this.noise.volumeCountdown = noise.envelopeTimer & 7;
        // The old LFSR counted from 0x7FFF and sounded on 0s; this one is inverted.
        this.noise.lfsr = ~noise.lfsr & 0x7fff;
        this.noise.narrow = noise.narrow;
        this.noise.currentLfsrSample = (this.noise.lfsr & 1) !== 0;
        this.noise.pulseLength = noise.length;
        this.noise.lengthEnabled = noise.lengthEnabled;
        this.noiseCounterActive = noise.dacOn;
        this.noiseBackgroundCounterActive = noise.enabled;
        this.channelSamples[NOISE] = noise.output;
        this.#restartOutput();
    }

    #restartOutput() {
        this.windowTime = 0;
        this.area.fill(0);
        this.areaTime.fill(0);
        for (let i = 0; i < 4; i++) this.#refreshLevel(i);
    }

    /**
     * The state the boot ROM leaves: registers after its chime; the chime's
     * channel is still on, faded out (`chime` false: the SGB plays none).
     */
    bootState(registers, chime) {
        for (const [addr, value] of registers) this.write(addr, value);
        this.isActive[SQUARE_1] = chime;
        this.square[0].currentVolume = 0;
        this.#refreshLevel(SQUARE_1);
        this.#settle();
    }

    /** Charges the output capacitor to the current level, so power-on doesn't thump. */
    #settle() {
        this.#mix(this.level);
        this.capLeft = this.mixLeft;
        this.capRight = this.mixRight;
    }

    /** Starts collecting the samples of a new video frame. */
    beginFrame() {
        this.length = 0;
    }

    get samples() {
        return this.buffer.subarray(0, this.length);
    }

    /** Whether the APU must run an M-cycle at a time (sweep and restart timings, as in SameBoy). */
    get #eager() {
        return this.sweepCalcCountdown !== 0 || this.ch1RestartHold !== 0 || this.sweepReloadTimer !== 0;
    }

    // --- Running ----------------------------------------------------------------------

    /**
     * Emulates the cycles accumulated in `pending`, in runs that end at each
     * output sample.
     */
    catchUp() {
        let cycles = this.pending >> 1;
        this.pending = 0;
        while (cycles > 0) {
            let step = Math.ceil((APU_RATE - this.sampleClock) / SAMPLE_RATE);
            if (step > cycles) step = cycles;
            if (this.#eager) step = Math.min(step, this.gb.doubleSpeed ? 1 : 2);
            this.#run(step);
            this.windowTime += step;
            this.sampleClock += step * SAMPLE_RATE;
            cycles -= step;
            if (this.sampleClock >= APU_RATE) {
                this.sampleClock -= APU_RATE;
                this.#emit();
            }
        }
        // Changes from outside a run (register writes, DIV events) happen now.
        this.chunkStart = this.windowTime;
    }

    /** Runs the channels for `cycles` 2 MHz cycles (GB_apu_run). */
    #run(cycles) {
        this.chunkStart = this.windowTime;
        const wave = this.wave;
        const noise = this.noise;
        const regs = this.regs;
        if (wave.buggedReadCountdown) {
            if (wave.buggedReadCountdown <= cycles) {
                wave.buggedReadCountdown = 0;
                wave.currentSampleByte = regs[WAVE_RAM + (this.#addressBus() & 0xf)];
                if (this.isActive[WAVE]) this.#updateWaveSample(0);
            } else {
                wave.buggedReadCountdown -= cycles;
            }
        }
        // The DMG's APU stops with the CPU (STOP).
        if (this.gb.cpu.stopped && !this.gb.cgb) return;
        let startNoise = false;
        if (noise.dmgDelayedStart) {
            if (noise.dmgDelayedStart === cycles) {
                noise.dmgDelayedStart = 0;
                startNoise = true;
            } else if (noise.dmgDelayedStart > cycles) {
                noise.dmgDelayedStart -= cycles;
            } else {
                // Run up to the start, then the rest.
                const first = noise.dmgDelayedStart;
                this.#run(first);
                this.chunkStart = this.windowTime + first;
                cycles -= first;
            }
        }

        // Channels 1, 2 and 4 run at 1 MHz: lfDiv is the phase.
        this.lfDiv ^= cycles & 1;
        noise.alignment = (noise.alignment + cycles) & 0xff;
        let sweepCycles = cycles >> 1;
        if (cycles & 1 && !this.lfDiv) sweepCycles++;
        if (this.sweepReloadTimer > sweepCycles) {
            this.sweepReloadTimer -= sweepCycles;
            sweepCycles = 0;
        } else {
            if (this.sweepReloadTimer && !this.sweepCalcCountdown && this.sweepInstantDone) this.#sweepCalculationDone(cycles);
            this.sweepInstantDone = false;
            sweepCycles -= this.sweepReloadTimer;
            this.sweepReloadTimer = 0;
        }
        // The calculation pauses while the shift is 0.
        if (this.sweepCalcCountdown && (regs[NR10] & 7 || this.unshiftedSweep)) {
            if (this.sweepCalcCountdown > sweepCycles) {
                this.sweepCalcCountdown -= sweepCycles;
            } else {
                this.sweepCalcCountdown = 0;
                this.#sweepCalculationDone(cycles);
            }
        }
        if (this.ch1RestartHold) this.ch1RestartHold = this.ch1RestartHold > cycles ? this.ch1RestartHold - cycles : 0;

        for (let i = SQUARE_1; i <= SQUARE_2; i++) {
            if (!this.isActive[i]) continue;
            const square = this.square[i];
            let left = cycles;
            if (square.delay) square.delay = square.delay < left ? 0 : square.delay - left;
            while (left > square.sampleCountdown) {
                left -= square.sampleCountdown + 1;
                square.sampleCountdown = (square.sampleLength ^ 0x7ff) * 2 + 1;
                square.currentSampleIndex = (square.currentSampleIndex + 1) & 7;
                square.sampleSurpressed = false;
                square.didTick = true;
                this.#updateSquareSample(i, cycles - left);
            }
            square.justReloaded = left === 0;
            if (left) square.sampleCountdown -= left;
        }

        wave.waveFormJustRead = false;
        if (this.isActive[WAVE]) {
            let left = cycles;
            while (left > wave.sampleCountdown) {
                left -= wave.sampleCountdown + 1;
                wave.sampleCountdown = wave.sampleLength ^ 0x7ff;
                wave.currentSampleIndex = (wave.currentSampleIndex + 1) & 0x1f;
                wave.currentSampleByte = regs[WAVE_RAM + (wave.currentSampleIndex >> 1)];
                this.#updateWaveSample(cycles - left);
                wave.waveFormJustRead = true;
            }
            if (left) {
                wave.sampleCountdown -= left;
                wave.waveFormJustRead = false;
            }
        } else if (wave.enable && wave.pulsed) {
            // Stopped by its length, the channel goes on reading wave RAM.
            let left = cycles;
            while (left > wave.sampleCountdown) {
                left -= wave.sampleCountdown + 1;
                wave.sampleCountdown = wave.sampleLength ^ 0x7ff;
                if (left) wave.currentSampleByte = regs[WAVE_RAM + (this.#addressBus() & 0xf)];
                else wave.buggedReadCountdown = 1;
            }
            if (left) wave.sampleCountdown -= left;
            if (wave.sampleCountdown === 0) wave.buggedReadCountdown = 2;
        }

        if (this.noiseCounterActive || this.noiseBackgroundCounterActive) {
            let left = cycles;
            let divisor = (regs[NR43] & 7) << 2;
            if (!divisor) divisor = 2;
            if (noise.counterCountdown === 0) noise.counterCountdown = divisor;
            // The counter ticks every `divisor` cycles; the LFSR steps when the
            // counter's bit NR43.4-7 rises. Jumps from one step to the next.
            const shift = regs[NR43] >> 4;
            while (left >= noise.counterCountdown) {
                let ticks = Infinity;
                if (shift < 14 && this.isActive[NOISE]) {
                    const period = 2 << shift;
                    ticks = ((1 << shift) - noise.counter) & (period - 1) || period;
                }
                const needed = noise.counterCountdown + (ticks - 1) * divisor;
                if (needed <= left) {
                    left -= needed;
                    noise.counter = (noise.counter + ticks) & 0x3fff;
                    noise.counterCountdown = divisor;
                    noise.didStepCounter = true;
                    this.#stepLfsr(cycles - left);
                    continue;
                }
                const count = 1 + Math.floor((left - noise.counterCountdown) / divisor);
                left -= noise.counterCountdown + (count - 1) * divisor;
                noise.counter = (noise.counter + count) & 0x3fff;
                noise.counterCountdown = divisor;
                noise.didStepCounter = true;
            }
            if (left) {
                noise.counterCountdown -= left;
                noise.countdownReloaded = false;
            } else {
                noise.countdownReloaded = true;
            }
        }
        if (startNoise) this.write(0xff23, regs[NR44] | 0x80);
    }

    /** The last address on the CPU's bus (approximated by the PC). */
    #addressBus() {
        return this.gb.cpu.pc;
    }

    // --- DIV events -------------------------------------------------------------------

    /** 512 Hz, from a falling edge of DIV bit 12 (13 in double speed). */
    divEvent() {
        this.catchUp();
        if (!this.power) return;
        if (this.skipDivEvent === SKIP) {
            this.skipDivEvent = SKIPPED;
            return;
        }
        if (this.skipDivEvent === SKIPPED) this.skipDivEvent = SKIP_INACTIVE;
        else this.divDivider = (this.divDivider + 1) & 0xff;

        if ((this.divDivider & 7) === 7) {
            for (const square of this.square) {
                if (!square.envelope.clock) square.volumeCountdown = (square.volumeCountdown - 1) & 7;
            }
            if (!this.noise.envelope.clock) this.noise.volumeCountdown = (this.noise.volumeCountdown - 1) & 7;
        }

        if (this.gb.doubleSpeed && this.gb.cgb) {
            // In double speed the envelopes step one M-cycle later (CGB-D/E).
            this.pendingEnvelopeTick = true;
        } else {
            this.#tickEnvelopes();
        }

        if (this.divDivider & 1) {
            for (let i = SQUARE_1; i <= SQUARE_2; i++) {
                const square = this.square[i];
                if (square.lengthEnabled && square.pulseLength && --square.pulseLength === 0) {
                    this.isActive[i] = false;
                    this.#updateSample(i, 0, 0);
                }
            }
            const wave = this.wave;
            if (wave.lengthEnabled && wave.pulseLength && --wave.pulseLength === 0) {
                this.isActive[WAVE] = false;
                this.#updateSample(WAVE, 0, 0);
            }
            const noise = this.noise;
            if (noise.lengthEnabled && noise.pulseLength && --noise.pulseLength === 0) {
                this.isActive[NOISE] = false;
                this.#updateSample(NOISE, 0, 0);
            }
        }

        if ((this.divDivider & 3) === 3) {
            this.sweepCountdown = (this.sweepCountdown + 1) & 7;
            this.#triggerSweepCalculation();
        }
    }

    /** A rising edge of the same DIV bit: envelopes reload their countdowns. */
    divSecondaryEvent() {
        this.catchUp();
        if (!this.power) return;
        for (let i = SQUARE_1; i <= SQUARE_2; i++) {
            const square = this.square[i];
            if (this.isActive[i] && square.volumeCountdown === 0) {
                const nrx2 = this.regs[i ? NR22 : NR12];
                square.volumeCountdown = nrx2 & 7;
                square.envelope.set(square.volumeCountdown !== 0, (nrx2 & 8) !== 0, square.currentVolume);
            }
        }
        const noise = this.noise;
        if (this.isActive[NOISE] && noise.volumeCountdown === 0) {
            noise.volumeCountdown = this.regs[NR42] & 7;
            noise.envelope.set(noise.volumeCountdown !== 0, (this.regs[NR42] & 8) !== 0, noise.currentVolume);
        }
    }

    /** The envelope step postponed by a DIV event in double speed. */
    delayedEnvelopeTick() {
        this.pendingEnvelopeTick = false;
        if (!this.power) return;
        this.catchUp();
        this.#tickEnvelopes();
    }

    #tickEnvelopes() {
        for (let i = SQUARE_1; i <= SQUARE_2; i++) {
            if (this.square[i].envelope.clock) this.#tickSquareEnvelope(i);
        }
        if (this.noise.envelope.clock) this.#tickNoiseEnvelope();
    }

    #tickSquareEnvelope(i) {
        const square = this.square[i];
        square.envelope.set(false, false, 0);
        if (square.envelope.locked) return;
        const nrx2 = this.regs[i ? NR22 : NR12];
        if (!(nrx2 & 7)) return;
        square.currentVolume = (square.currentVolume + (nrx2 & 8 ? 1 : -1)) & 0xff;
        if (this.isActive[i]) this.#updateSquareSample(i, 0);
    }

    #tickNoiseEnvelope() {
        const noise = this.noise;
        noise.envelope.set(false, false, 0);
        if (noise.envelope.locked) return;
        const nr42 = this.regs[NR42];
        if (!(nr42 & 7)) return;
        noise.currentVolume = (noise.currentVolume + (nr42 & 8 ? 1 : -1)) & 0xff;
        if (this.isActive[NOISE]) this.#updateSample(NOISE, noise.lfsr & 1 ? noise.currentVolume : 0, 0);
    }

    // --- Sweep ------------------------------------------------------------------------

    #sweepCalculationDone(cycles) {
        // APU bug: the frequency is checked after adding the delta twice.
        if (this.ch1RestartHold === 0) this.shadowSweepSampleLength = this.square[0].sampleLength;
        if (this.regs[NR10] & 8) this.sweepLengthAddend ^= 0x7ff;
        if (this.shadowSweepSampleLength + this.sweepLengthAddend > 0x7ff && !(this.regs[NR10] & 8)) {
            this.isActive[SQUARE_1] = false;
            this.#updateSample(SQUARE_1, 0, this.sweepCalcCountdown * 2 - cycles);
        }
        this.ch1CompletedAddend = this.sweepLengthAddend;
    }

    #triggerSweepCalculation() {
        const nr10 = this.regs[NR10];
        if (!(nr10 & 0x70) || this.sweepCountdown !== 7) return;
        if (nr10 & 7) {
            this.square[0].sampleLength = (this.sweepLengthAddend + this.shadowSweepSampleLength + (nr10 & 8 ? 1 : 0)) & 0x7ff;
        }
        if (this.ch1RestartHold === 0) this.sweepLengthAddend = this.square[0].sampleLength >> (nr10 & 7);
        // The new frequency is checked for overflow after a delay.
        this.sweepCalcCountdown = nr10 & 7;
        this.sweepReloadTimer = !this.gb.doubleSpeed && this.duringDivWrite ? 1 : 1 + this.lfDiv;
        this.unshiftedSweep = !(nr10 & 7);
        this.sweepCountdown = ((nr10 >> 4) & 7) ^ 7;
        if (this.sweepCalcCountdown === 0) this.sweepInstantDone = true;
    }

    // --- Samples and output -----------------------------------------------------------

    #dacEnabled(i) {
        switch (i) {
            case SQUARE_1: return (this.regs[NR12] & 0xf8) !== 0;
            case SQUARE_2: return (this.regs[NR22] & 0xf8) !== 0;
            case WAVE: return this.wave.enable;
            default: return (this.regs[NR42] & 0xf8) !== 0;
        }
    }

    /** A channel's digital output changes, `offset` cycles into the current run. */
    #updateSample(i, value, offset) {
        if (value === 0 && this.channelSamples[i] === 0) return;
        // With the DAC off the output keeps its last value (and is silent).
        if (!this.#dacEnabled(i)) return;
        this.#integrate(i, offset);
        this.channelSamples[i] = value;
        this.level[i] = value / 7.5 - 1;
    }

    #updateSquareSample(i, offset) {
        const square = this.square[i];
        if (square.sampleSurpressed) return;
        const duty = this.regs[i ? NR21 : NR11] >> 6;
        this.#updateSample(i, DUTIES[square.currentSampleIndex + duty * 8] ? square.currentVolume : 0, offset);
    }

    #updateWaveSample(offset) {
        const wave = this.wave;
        const byte = wave.currentSampleByte;
        this.#updateSample(WAVE, (wave.currentSampleIndex & 1 ? byte & 0xf : byte >> 4) >> wave.shift, offset);
    }

    /** Adds channel i's level up to `offset` cycles into the current run. */
    #integrate(i, offset) {
        const time = this.chunkStart + Math.max(0, offset);
        if (time <= this.areaTime[i]) return;
        this.area[i] += this.level[i] * (time - this.areaTime[i]);
        this.areaTime[i] = time;
    }

    /** After a DAC turns on or off: the channel's analog level from now on. */
    #refreshLevel(i) {
        this.#integrate(i, this.windowTime - this.chunkStart);
        this.level[i] = this.#dacEnabled(i) ? this.channelSamples[i] / 7.5 - 1 : 0;
    }

    /** mixLeft/mixRight from four channel levels (or sums), with NR51 panning and NR50 volume. */
    #mix(levels) {
        const panning = this.regs[NR51];
        let left = 0;
        let right = 0;
        for (let i = 0; i < 4; i++) {
            if (panning & (0x10 << i)) left += levels[i];
            if (panning & (1 << i)) right += levels[i];
        }
        // Master volume (1-8) / 8, and / 4 channels: everything at full volume reaches ±1.
        const volume = this.regs[NR50];
        this.mixLeft = (left * (((volume >> 4) & 7) + 1)) / 32;
        this.mixRight = (right * ((volume & 7) + 1)) / 32;
    }

    #emit() {
        const time = this.windowTime;
        for (let i = 0; i < 4; i++) {
            const until = time - this.areaTime[i];
            this.area[i] = (this.area[i] + this.level[i] * until) / time;
        }
        this.#mix(this.area);
        const left = this.mixLeft;
        const right = this.mixRight;
        this.area.fill(0);
        this.areaTime.fill(0);
        this.windowTime = 0;
        const outLeft = left - this.capLeft;
        const outRight = right - this.capRight;
        this.capLeft = left - outLeft * HIGH_PASS;
        this.capRight = right - outRight * HIGH_PASS;
        if (this.length + 2 <= this.buffer.length) {
            this.buffer[this.length++] = outLeft;
            this.buffer[this.length++] = outRight;
        }
    }

    // --- Noise --------------------------------------------------------------------------

    #updateLfsr(offset) {
        const noise = this.noise;
        noise.currentLfsrSample = (noise.lfsr & 1) !== 0;
        if (this.isActive[NOISE]) this.#updateSample(NOISE, noise.currentLfsrSample ? noise.currentVolume : 0, offset);
    }

    #stepLfsr(offset) {
        const noise = this.noise;
        this.lfsrBit7BeforeStep = (noise.lfsr & 0x80) !== 0;
        const highBits = noise.narrow ? 0x4040 : 0x4000;
        const newHighBit = (noise.lfsr ^ (noise.lfsr >> 1) ^ 1) & 1;
        noise.lfsr >>= 1;
        // Clearing matters when the width changed.
        if (newHighBit) noise.lfsr |= highBits;
        else noise.lfsr &= ~highBits;
        this.#updateLfsr(offset);
        this.lfsrSteppedInNarrow = noise.narrow;
    }

    /** NR44 trigger: the counter's phase after the start (SameBoy's prepare_noise_start). */
    #prepareNoiseStart() {
        const noise = this.noise;
        const regs = this.regs;
        const dmg = !this.gb.cgb;
        this.noiseCounterActive = (regs[NR42] & 0xf8) !== 0; // until the APU or the DAC goes off
        const wasStartedWithDacDisabled = this.noiseStartedWithDacDisabled;
        this.noiseStartedWithDacDisabled = !this.noiseCounterActive;
        let divisor = regs[NR43] & 7;
        const wasBackgroundCounting = this.noiseBackgroundCounterActive;
        this.noiseBackgroundCounterActive = true;
        let instantStep = false;
        let div1Glitch = false;

        if (divisor > 1 && noise.counterCountdown === 1) {
            noise.counter = (noise.counter + 1) & 0x3fff;
        } else if (noise.counterCountdown === 2 && (noise.alignment & 3) === 0 && this.isActive[NOISE]) {
            if (divisor === 0) {
                divisor = 8;
            } else if (divisor === 1) {
                if (!noise.didStepCounter) div1Glitch = true;
                const mask = 1 << (regs[NR43] >> 4);
                const oldBit = noise.counter & mask;
                noise.counter = (noise.counter + 1) & 0x3fff;
                if (noise.counter & mask && !oldBit) instantStep = true;
            }
        }
        let countdown = divisor === 0 ? 6 : divisor * 4 + 6;
        if (noise.alignment & 1) {
            if (!divisor) {
                if (dmg) countdown++;
                else if (wasBackgroundCounting) countdown--;
                else countdown++;
            } else if (noise.alignment & 2) {
                if (divisor === 1 && !this.isActive[NOISE]) countdown++;
                else countdown -= 3;
            } else {
                countdown--;
                if (divisor === 1 && this.isActive[NOISE]) countdown -= 4;
            }
        } else if (divisor) {
            if (noise.alignment & 2) countdown -= 2;
            else if (divisor > 1) countdown -= 4;
            else if (divisor === 1 && this.isActive[NOISE] && !(regs[NR43] & 0xf0)) countdown -= 4;
        }
        // Background counting glitches.
        if (divisor > 1) {
            if (!this.noiseCounterActive && !(noise.alignment & 3)) countdown += 4;
        } else if (wasBackgroundCounting && !this.isActive[NOISE] && !(noise.alignment & 3)) {
            if (divisor === 0) {
                if (wasStartedWithDacDisabled) countdown += 28;
            } else {
                countdown -= 4;
            }
        }
        if (div1Glitch) countdown -= 4;
        noise.counterCountdown = countdown & 0xff;
        noise.lfsr = !divisor && this.isActive[NOISE] && (noise.alignment & 3) === 3 ? 0x0055 : 0;
        if (instantStep) this.#stepLfsr(0);
    }

    /** NR43 writes glitch the LFSR (CGB-E and DMG behavior after SameBoy). */
    #nr43Write(value) {
        const noise = this.noise;
        const regs = this.regs;
        const cgb = this.gb.cgb;
        const oldNarrow = noise.narrow;
        noise.narrow = (value & 8) !== 0;
        const old = regs[NR43];
        regs[NR43] = value;
        if ((old & 0xf0) === (value & 0xf0)) return;
        let counter = noise.counter;
        if (!cgb && noise.countdownReloaded) counter |= (counter - 1) & 0x3fff;
        const oldBit = (counter >> (old >> 4)) & 1;
        const glitchValue = (old & 0x7f) | (value & 0x80);
        const glitchBit = (counter >> (glitchValue >> 4)) & 1;
        const newBit = (counter >> (value >> 4)) & 1;

        if (oldBit === newBit && newBit !== glitchBit) {
            if (newBit) {
                // Category 1 (only the CGB-E is emulated here).
                if (!cgb) return;
                if (!(value & 0x80)) {
                    this.#stepLfsr(0);
                    return;
                }
                const t1 = (old >> 4) & 7;
                const t2 = (value >> 4) & 7;
                if ((t1 ^ 7) + t2 > 7 || ((t1 ^ 7) & t2)) {
                    // Copy bit 8 to bit 7.
                    noise.lfsr = (noise.lfsr & ~0x80) | ((noise.lfsr >> 1) & 0x80);
                    if ((t1 === 0 || t1 === 4) && t2 === 3) {
                        noise.lfsr &= (noise.lfsr >> 1) | 0x545;
                        this.#updateLfsr(0);
                    } else if (t1 === 2 && t2 === 3) {
                        let mask = 0x555;
                        if ((noise.lfsr & 0xc) === 0xc) mask |= 8;
                        if ((noise.lfsr & 0xc00) === 0xc00) mask |= 0x800;
                        noise.lfsr &= (noise.lfsr >> 1) | mask;
                        this.#updateLfsr(0);
                    }
                    if (!noise.narrow && oldNarrow && this.lfsrSteppedInNarrow) {
                        if (this.lfsrBit7BeforeStep) noise.lfsr |= 0x40;
                        else noise.lfsr &= ~0x40;
                    }
                    noise.lfsr |= noise.narrow ? 0x4040 : 0x4000;
                    this.lfsrSteppedInNarrow = noise.narrow;
                }
            } else if (cgb) {
                // Category 2.
                const glitch = value & 0x80 ? NR43_GLITCHES[((old & 0x70) >> 1) | ((value & 0x70) >> 4)] : 0;
                switch (glitch) {
                    case 1: // step, then bit 1 &= bit 0
                    case 6: // like 1, with the LFSR's bit - 1 glitched too
                        this.#stepLfsr(0);
                        if (glitch === 6) {
                            if ((noise.narrow && (noise.lfsr & 0x71) === 0x20) || (noise.lfsr & 0x71) === 0x61) noise.lfsr &= ~0x20;
                            if ((noise.lfsr & 0x7001) === 0x2000 || (noise.lfsr & 0x7001) === 0x6001) noise.lfsr &= ~0x2000;
                        }
                        if ((noise.lfsr & 3) === 2) noise.lfsr &= ~2;
                        break;
                    case 2: { // step, AND with the previous value except bit 0
                        const previous = noise.lfsr;
                        this.#stepLfsr(0);
                        noise.lfsr &= previous | 1;
                        break;
                    }
                    case 5: // like 3, after clearing some bits
                        if ((noise.lfsr & 3) === 2) noise.lfsr &= noise.narrow ? ~0x4040 : ~0x4000;
                        if ((noise.lfsr & 0x19) === 8) noise.lfsr &= ~8;
                    // falls through
                    case 3: // no step: bit 0 = bit 1
                        noise.lfsr = (noise.lfsr & ~1) | ((noise.lfsr >> 1) & 1);
                        this.#updateLfsr(0);
                        this.lfsrSteppedInNarrow = noise.narrow;
                        break;
                    case 4: { // step, bit 1 &= bit 0, LFSR bit - 1 &= LFSR bit
                        const previous = noise.lfsr;
                        this.#stepLfsr(0);
                        noise.lfsr &= previous | (noise.narrow ? ~0x2022 : ~0x2002);
                        break;
                    }
                    default:
                        this.#stepLfsr(0);
                }
                noise.lfsr &= 0xffff;
            } else {
                this.#stepLfsr(0);
            }
        } else if (!oldBit && newBit) {
            if (!cgb) {
                const narrow = noise.narrow;
                noise.narrow = true;
                this.#stepLfsr(0);
                noise.narrow = narrow;
                if ((value & 0xf0) <= 0x20 && glitchBit && !(counter & 8)) {
                    this.#stepLfsr(0);
                    noise.lfsr &= ~(noise.narrow ? 0x4040 : 0x4000);
                    noise.lfsr |= (noise.lfsr & (noise.narrow ? 0x2020 : 0x2000)) << 1;
                }
            } else {
                this.#stepLfsr(0);
            }
        } else if (!cgb) {
            if ((value & 0xf0) <= 0x20 && !glitchBit && !newBit && !oldBit && counter & 8) this.#stepLfsr(0);
        }
    }

    // --- Registers --------------------------------------------------------------------

    /** PCM12/PCM34 (CGB): current digital outputs of two channels. */
    readPcm(addr) {
        this.catchUp();
        const [low, high] = addr === 0xff76 ? [SQUARE_1, SQUARE_2] : [WAVE, NOISE];
        return (this.isActive[high] ? this.channelSamples[high] << 4 : 0) | (this.isActive[low] ? this.channelSamples[low] : 0);
    }

    read(addr) {
        this.catchUp();
        let i = addr - 0xff10;
        if (i === NR52) {
            return 0x70 | (this.power ? 0x80 : 0) | (this.isActive[0] ? 1 : 0) | (this.isActive[1] ? 2 : 0) |
                (this.isActive[2] ? 4 : 0) | (this.isActive[3] ? 8 : 0);
        }
        if (i >= WAVE_RAM) {
            // While playing, the CPU reaches the byte the channel reads (the
            // DMG only in the cycle it reads it).
            if (this.isActive[WAVE]) {
                if (!this.gb.cgb && !this.wave.waveFormJustRead) return 0xff;
                i = WAVE_RAM + (this.wave.currentSampleIndex >> 1);
            }
            return this.regs[i];
        }
        return this.regs[i] | READ_MASKS[i];
    }

    write(addr, value) {
        this.catchUp();
        let i = addr - 0xff10;
        const cgb = this.gb.cgb;
        // Powered off, only the DMG's length counters can be written.
        if (!this.power && i !== NR52 && i < WAVE_RAM && (cgb || (i !== NR11 && i !== NR21 && i !== NR31 && i !== NR41))) return;
        if (i >= WAVE_RAM && this.isActive[WAVE]) {
            if (!cgb && !this.wave.waveFormJustRead) return;
            i = WAVE_RAM + (this.wave.currentSampleIndex >> 1);
        }
        const regs = this.regs;
        switch (i) {
            case NR52: this.#writePower(value); break;
            case NR10: this.#writeNr10(value); break;
            case NR11:
            case NR21:
                this.square[i === NR21 ? 1 : 0].pulseLength = 0x40 - (value & 0x3f);
                if (!this.power) value &= 0x3f;
                break;
            case NR12:
            case NR22: {
                const index = i === NR22 ? SQUARE_2 : SQUARE_1;
                const square = this.square[index];
                if ((value & 0xf8) === 0) {
                    // The DAC goes off.
                    regs[i] = value;
                    this.isActive[index] = false;
                    this.#updateSample(index, 0, 0);
                    this.#refreshLevel(index);
                } else {
                    const dacWasOff = (regs[i] & 0xf8) === 0;
                    if (this.isActive[index]) {
                        this.#nrx2Glitch(square, value, regs[i]);
                        regs[i] = value;
                        this.#updateSquareSample(index, 0);
                    }
                    regs[i] = value;
                    if (dacWasOff) this.#refreshLevel(index);
                }
                break;
            }
            case NR13:
            case NR23: {
                const square = this.square[i === NR23 ? 1 : 0];
                square.sampleLength = (square.sampleLength & ~0xff) | value;
                if (square.justReloaded) square.sampleCountdown = (square.sampleLength ^ 0x7ff) * 2 + 1;
                break;
            }
            case NR14:
            case NR24: this.#writeSquareControl(i === NR24 ? SQUARE_2 : SQUARE_1, value); break;
            case NR30: this.#writeNr30(value); break;
            case NR31: this.wave.pulseLength = 0x100 - value; break;
            case NR32:
                this.wave.shift = [4, 0, 1, 2][(value >> 5) & 3];
                if (this.isActive[WAVE]) this.#updateWaveSample(0);
                break;
            case NR33:
                this.wave.sampleLength = (this.wave.sampleLength & ~0xff) | value;
                if (this.wave.buggedReadCountdown === 1) this.wave.sampleCountdown = this.wave.sampleLength ^ 0x7ff;
                break;
            case NR34: this.#writeNr34(value); break;
            case NR41: this.noise.pulseLength = 0x40 - (value & 0x3f); break;
            case NR42: this.#writeNr42(value); break;
            case NR43: this.#writeNr43(value); break;
            case NR44: this.#writeNr44(value); break;
        }
        regs[i] = value;
    }

    #writePower(value) {
        const lengths = [this.square[0].pulseLength, this.square[1].pulseLength, this.wave.pulseLength, this.noise.pulseLength];
        if (value & 0x80 && !this.power) {
            this.#init();
            this.power = true;
        } else if (!(value & 0x80) && this.power) {
            for (let i = 0; i < 4; i++) this.#updateSample(i, 0, 0);
            this.#clear();
            this.regs.fill(0, 0, WAVE_RAM);
            for (let i = 0; i < 4; i++) this.#refreshLevel(i);
        }
        // The DMG keeps the lengths written while powered off.
        if (!this.gb.cgb && value & 0x80) {
            [this.square[0].pulseLength, this.square[1].pulseLength, this.wave.pulseLength, this.noise.pulseLength] = lengths;
        }
    }

    #writeNr10(value) {
        if (this.sweepCalcCountdown || this.sweepReloadTimer) this.#nr10Glitch(value);
        const oldNegate = !this.gb.cgb || (this.regs[NR10] & 8) !== 0;
        this.regs[NR10] = value;
        if (this.shadowSweepSampleLength + this.ch1CompletedAddend + (oldNegate ? 1 : 0) > 0x7ff && !(value & 8)) {
            this.isActive[SQUARE_1] = false;
            this.#updateSample(SQUARE_1, 0, 0);
        }
        this.#triggerSweepCalculation();
    }

    #nr10Glitch(value) {
        if (!this.gb.cgb) {
            // The DMG (no double speed): only the zombie step.
            if (this.sweepReloadTimer === 1 && !this.lfDiv) return;
            if (this.sweepReloadTimer > 1) return;
            if (this.sweepCalcCountdown && !(this.regs[NR10] & 7) && this.lfDiv) {
                if (--this.sweepCalcCountdown <= 1) {
                    this.sweepCalcCountdown = 0;
                    this.#sweepCalculationDone(0);
                }
            }
            return;
        }
        if (this.sweepReloadTimer === 2) {
            // The countdown just reloaded: it reloads again.
            this.sweepCalcCountdown = value & 7;
            if (!this.sweepCalcCountdown) this.sweepReloadTimer = 0;
        }
        if (value & 7 && !(this.regs[NR10] & 7) && !this.lfDiv && this.sweepCalcCountdown > 1) {
            if (--this.sweepCalcCountdown === 0) this.#sweepCalculationDone(0);
        }
    }

    /** NRx2 writes while playing change the volume ("zombie mode"). */
    #nrx2Glitch(channel, value, oldValue) {
        if (!this.gb.cgb) {
            nrx2GlitchStep(channel, 0xff, oldValue);
            nrx2GlitchStep(channel, value, 0xff);
        } else {
            nrx2GlitchStep(channel, value, oldValue);
        }
    }

    #writeSquareControl(index, value) {
        const square = this.square[index];
        const regs = this.regs;
        const nrx4 = index ? NR24 : NR14;
        const nrx2 = index ? NR22 : NR12;
        const cgb = this.gb.cgb;
        const wasActive = this.isActive[index];
        // The sample length changing just before an update from ≥$700 to <$700
        // keeps the old sample (SameBoy steps the index back).
        if (!(value & 0x80) && this.isActive[index] && (regs[nrx4] & 7) === 7 && (value & 7) !== 7) {
            if ((cgb || square.sampleCountdown & 1) && square.didTick &&
                square.sampleCountdown >> 1 === (square.sampleLength ^ 0x7ff)) {
                square.currentSampleIndex = (square.currentSampleIndex - 1) & 7;
                square.sampleSurpressed = false;
            }
        }
        const oldSampleLength = square.sampleLength;
        square.sampleLength = (square.sampleLength & 0xff) | ((value & 7) << 8);
        if (square.justReloaded) square.sampleCountdown = (square.sampleLength ^ 0x7ff) * 2 + 1;
        if (value & 0x80) {
            // The duty position keeps going; only powering off resets it.
            square.envelope.locked = false;
            square.envelope.clock = false;
            square.didTick = false;
            let forceUnsurpressed = false;
            if (!this.isActive[index]) {
                if (cgb && !(value & 4) && !(Math.trunc((square.sampleCountdown - square.delay) / 2) & 0x400)) {
                    square.currentSampleIndex = (square.currentSampleIndex + 1) & 7;
                    forceUnsurpressed = true;
                }
                square.delay = 6 - this.lfDiv;
                square.sampleCountdown = ((square.sampleLength ^ 0x7ff) * 2 + square.delay) & 0xffff;
            } else {
                let extraDelay = 0;
                if (cgb) {
                    if (!square.justReloaded && !(value & 4) && !(Math.trunc((square.sampleCountdown - 1 - square.delay) / 2) & 0x400)) {
                        square.currentSampleIndex = (square.currentSampleIndex + 1) & 7;
                        square.sampleSurpressed = false;
                    } else if (square.sampleLength === 0x7ff && oldSampleLength !== 0x7ff && square.sampleSurpressed) {
                        extraDelay += 2;
                    }
                }
                // Already playing, the sound restarts 2 cycles sooner.
                square.delay = 4 - this.lfDiv + extraDelay;
                square.sampleCountdown = ((square.sampleLength ^ 0x7ff) * 2 + square.delay) & 0xffff;
            }
            square.currentVolume = regs[nrx2] >> 4;
            // The volume takes effect at once (on the sound still playing).
            if (this.isActive[index]) this.#updateSquareSample(index, 0);
            square.volumeCountdown = regs[nrx2] & 7;
            if (regs[nrx2] & 0xf8 && !this.isActive[index]) {
                this.isActive[index] = true;
                this.#updateSample(index, 0, 0);
                square.sampleSurpressed = !forceUnsurpressed;
            }
            if (square.pulseLength === 0) {
                square.pulseLength = 0x40;
                square.lengthEnabled = false;
            }
            if (index === SQUARE_1) {
                this.sweepInstantDone = false;
                this.shadowSweepSampleLength = 0;
                this.ch1CompletedAddend = 0;
                if (regs[NR10] & 7) {
                    // APU bug: with a nonzero shift, the overflow check also runs on trigger.
                    this.sweepCalcCountdown = regs[NR10] & 7;
                    this.sweepReloadTimer = (this.lfDiv ^ (this.gb.doubleSpeed ? 0 : 1)) && !cgb ? 3 : 2;
                    this.unshiftedSweep = false;
                    if (!wasActive) this.sweepReloadTimer++;
                    this.sweepLengthAddend = square.sampleLength >> (regs[NR10] & 7);
                } else {
                    this.sweepLengthAddend = 0;
                }
                this.ch1RestartHold = 2 - this.lfDiv + (cgb ? 2 : 0);
                this.sweepCountdown = ((regs[NR10] >> 4) & 7) ^ 7;
            }
        }
        // APU bug: enabling the length in the first half of its period ticks it once.
        if (value & 0x40 && !square.lengthEnabled && this.divDivider & 1 && square.pulseLength) {
            if (--square.pulseLength === 0) {
                if (value & 0x80) {
                    square.pulseLength = 0x3f;
                } else {
                    this.isActive[index] = false;
                    this.#updateSample(index, 0, 0);
                }
            }
        }
        square.lengthEnabled = (value & 0x40) !== 0;
    }

    #writeNr30(value) {
        const wave = this.wave;
        wave.enable = (value & 0x80) !== 0;
        if (!wave.enable) {
            wave.pulsed = false;
            if (this.isActive[WAVE]) {
                if (wave.sampleCountdown === 0) {
                    wave.currentSampleByte = this.regs[WAVE_RAM + (this.gb.cpu.pc & 0xf)];
                } else if (wave.waveFormJustRead && !this.gb.cgb) {
                    wave.currentSampleByte = this.regs[WAVE_RAM + 0xa]; // FF1A's low nibble
                }
            }
            this.isActive[WAVE] = false;
            this.#updateSample(WAVE, 0, 0);
        }
        this.#refreshLevel(WAVE);
    }

    #writeNr34(value) {
        const wave = this.wave;
        const regs = this.regs;
        wave.sampleLength = (wave.sampleLength & 0xff) | ((value & 7) << 8);
        if (value & 0x80) {
            wave.pulsed = true;
            // DMG bug: retriggering the cycle before the channel reads wave RAM corrupts it.
            if (!this.gb.cgb && this.isActive[WAVE] && wave.sampleCountdown === 0) {
                const offset = ((wave.currentSampleIndex + 1) >> 1) & 0xf;
                if (offset < 4) regs[WAVE_RAM] = regs[WAVE_RAM + offset];
                else regs.copyWithin(WAVE_RAM, WAVE_RAM + (offset & ~3), WAVE_RAM + (offset & ~3) + 4);
            }
            wave.currentSampleIndex = 0;
            if (this.isActive[WAVE] && wave.sampleCountdown === 0) wave.currentSampleByte = regs[WAVE_RAM];
            if (wave.enable) {
                this.isActive[WAVE] = true;
                this.#updateSample(WAVE, (wave.currentSampleByte >> 4) >> wave.shift, 0);
            }
            wave.sampleCountdown = (wave.sampleLength ^ 0x7ff) + 3;
            if (wave.pulseLength === 0) {
                wave.pulseLength = 0x100;
                wave.lengthEnabled = false;
            }
        }
        if (value & 0x40 && !wave.lengthEnabled && this.divDivider & 1 && wave.pulseLength) {
            if (--wave.pulseLength === 0) {
                if (value & 0x80) {
                    wave.pulseLength = 0xff;
                } else {
                    this.isActive[WAVE] = false;
                    this.#updateSample(WAVE, 0, 0);
                }
            }
        }
        wave.lengthEnabled = (value & 0x40) !== 0;
    }

    #writeNr42(value) {
        const noise = this.noise;
        const regs = this.regs;
        if ((value & 0xf8) === 0) {
            // The DAC goes off.
            if (this.isActive[NOISE] && regs[NR43] & 7) {
                if (noise.counterCountdown <= 2) noise.counter = (noise.counter + 1) & 0x3fff;
                this.noiseBackgroundCounterActive = false;
            }
            regs[NR42] = value;
            this.isActive[NOISE] = false;
            this.#updateSample(NOISE, 0, 0);
            this.noiseCounterActive = false;
            this.#refreshLevel(NOISE);
            return;
        }
        const dacWasOff = (regs[NR42] & 0xf8) === 0;
        if (this.isActive[NOISE]) {
            this.#nrx2Glitch(noise, value, regs[NR42]);
            regs[NR42] = value;
            this.#updateSample(NOISE, noise.currentLfsrSample ? noise.currentVolume : 0, 0);
        }
        regs[NR42] = value;
        if (dacWasOff) this.#refreshLevel(NOISE);
    }

    #writeNr43(value) {
        const noise = this.noise;
        if (noise.countdownReloaded) {
            let divisor = (value & 7) << 2;
            if (!divisor) divisor = 2;
            const align = this.gb.cgb ? [2, 1, 0, 3] : [2, 1, 4, 3];
            noise.counterCountdown = divisor + (divisor === 2 ? 0 : align[noise.alignment & 3]);
        }
        if (!this.gb.cgb) {
            if (noise.countdownReloaded) {
                const nr43 = this.regs[NR43];
                const oldBit = (noise.counter >> (nr43 >> 4)) & 1;
                const glitchBit = (noise.counter >> 7) & 1;
                const newBit = (noise.counter >> (value >> 4)) & 1;
                if (!oldBit && newBit && glitchBit) {
                    const previous = (noise.counter - 1) & 0x3fff;
                    if ((previous >> (nr43 >> 4)) & 1 && !((previous >> (value >> 4)) & 1) && (previous >> 7) & 1) {
                        this.#stepLfsr(0);
                    }
                }
            }
            this.#nr43Write(0xff);
        }
        this.#nr43Write(value);
    }

    #writeNr44(value) {
        const noise = this.noise;
        const regs = this.regs;
        if (value & 0x80) {
            noise.envelope.locked = false;
            noise.envelope.clock = false;
            if (!this.gb.cgb && (noise.alignment & 3) !== 0) {
                noise.dmgDelayedStart = 6;
            } else {
                noise.lfsr = 0;
                this.#prepareNoiseStart();
                noise.currentVolume = regs[NR42] >> 4;
                noise.currentLfsrSample = false;
                noise.volumeCountdown = regs[NR42] & 7;
                noise.didStepCounter = (noise.alignment & 3) === 2;
                if (regs[NR42] & 0xf8) {
                    this.isActive[NOISE] = true;
                    this.#updateSample(NOISE, 0, 0);
                }
                if (noise.pulseLength === 0) {
                    noise.pulseLength = 0x40;
                    noise.lengthEnabled = false;
                }
            }
        }
        if (value & 0x40 && !noise.lengthEnabled && this.divDivider & 1 && noise.pulseLength) {
            if (--noise.pulseLength === 0) {
                if (value & 0x80) {
                    noise.pulseLength = 0x3f;
                } else {
                    this.isActive[NOISE] = false;
                    this.#updateSample(NOISE, 0, 0);
                }
            }
        }
        noise.lengthEnabled = (value & 0x40) !== 0;
    }
}

// NR43 category 2 glitches on the CGB-E, by old (octal tens) and new (units)
// shift, for writes with bit 7 set.
const NR43_GLITCHES = new Uint8Array(64);
for (const [index, glitch] of [
    [0o02, 4], [0o03, 2], [0o04, 2], [0o05, 2],
    [0o12, 2], [0o13, 4], [0o14, 2], [0o15, 2],
    [0o20, 1], [0o21, 2], [0o23, 1], [0o24, 5], [0o25, 3],
    [0o34, 2], [0o35, 2],
    [0o41, 2], [0o42, 2], [0o43, 2],
    [0o50, 6], [0o52, 2], [0o53, 2],
]) NR43_GLITCHES[index] = glitch;

/** One NRx2 write's effect on a playing channel's volume (SameBoy's _nrx2_glitch). */
function nrx2GlitchStep(channel, value, oldValue) {
    const envelope = channel.envelope;
    if (envelope.clock) channel.volumeCountdown = value & 7;
    let tick = (value & 7) !== 0 && !(oldValue & 7) && !envelope.locked;
    const invert = ((value ^ oldValue) & 8) !== 0;
    if ((value & 0xf) === 8 && (oldValue & 0xf) === 8 && !envelope.locked) tick = true;
    if (invert) {
        if (value & 8) {
            if (!(oldValue & 7) && !envelope.locked) channel.currentVolume ^= 0xf;
            else channel.currentVolume = (0xe - channel.currentVolume) & 0xf;
            tick = false;
        } else {
            channel.currentVolume = (0x10 - channel.currentVolume) & 0xf;
        }
    }
    if (tick) channel.currentVolume = (channel.currentVolume + (value & 8 ? 1 : -1)) & 0xf;
    else if (!(value & 7) && envelope.clock) envelope.set(false, false, 0);
}
