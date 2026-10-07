// The Game Boy's sound channels as simple timers: length, envelope, sweep and
// the waveform steps, without the APU's internal clock alignment. The GBA's
// sound (gba/apu.js) builds on them; the Game Boy's own APU (apu.js) reads
// older save states with them.

const DUTY_PATTERNS = [0b00000001, 0b10000001, 0b10000111, 0b01111110];
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];
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
        // The envelope reached 0 or 15 and stopped.
        this.envelopeDone = false;
    }

    sync(s) {
        for (const flag of ["enabled", "dacOn", "lengthEnabled", "envelopeUp", "envelopeDone"]) this[flag] = s.bool(this[flag]);
        for (const field of ["length", "frequency", "volume", "envelopeInitial", "envelopePeriod", "envelopeTimer"]) {
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
        else this.envelopeDone = true;
    }

    /** NRx2: volume envelope; the top 5 bits all zero turn the DAC off. */
    writeEnvelope(value) {
        if (this.enabled) {
            // "Zombie mode": writing while playing changes the volume (as on the
            // CGB-02/04, the most consistent models). Games use $08 to add 1.
            if (this.envelopePeriod === 0 && !this.envelopeDone) this.volume++;
            else if (!this.envelopeUp) this.volume += 2;
            if (this.envelopeUp !== ((value & 0x08) !== 0)) this.volume = 16 - this.volume;
            this.volume &= 15;
        }
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
        this.envelopeDone = false;
        return true;
    }
}

export class SquareChannel extends Channel {
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
        for (const field of ["duty", "dutyStep", "sweepPeriod", "sweepShift", "sweepTimer", "sweepFrequency"]) {
            this[field] = s.u16(this[field]);
        }
        for (const flag of ["sweepDown", "sweepEnabled", "sweepSubtracted"]) this[flag] = s.bool(this[flag]);
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

export class WaveChannel extends Channel {
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

export class NoiseChannel extends Channel {
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
