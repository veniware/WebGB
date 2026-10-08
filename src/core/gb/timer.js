/*
 * The system counter's timing is ported from SameBoy's Core/timing.c.
 * SameBoy's license:
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

import { Interrupt } from "./constants.js";

// System-counter bit whose falling edge clocks TIMA, per TAC clock select.
const TAC_BITS = [1 << 9, 1 << 3, 1 << 5, 1 << 7];

// TIMA after an overflow: it reads 0 for 4 T-cycles (RELOADING), then the
// interrupt is raised and writes to TIMA are ignored for 4 more (RELOADED).
const Tima = { RUNNING: 0, RELOADING: 1, RELOADED: 2 };

/**
 * DIV/TIMA/TMA/TAC. Everything runs off a 16-bit system counter (DIV is its
 * upper byte) that advances by 4 every 4 T-cycles, 3 T-cycles after a DIV
 * reset (as in SameBoy's timers_run, MIT). TIMA, the serial clock and the
 * APU's frame sequencer are clocked by falling edges of counter bits, so
 * resetting DIV or changing TAC can clock them early, as on hardware.
 */
export class Timer {
    /** @param {import("./gameboy.js").GameBoy} gb */
    constructor(gb) {
        this.gb = gb;
        this.cpu = gb.cpu;
        this.apu = gb.apu;
        this.reset(0);
    }

    /**
     * @param {number} counter The system counter.
     * @param {number} [divCycles] -3 to 0: the counter steps after 1 - divCycles more T-cycles.
     */
    reset(counter, divCycles = 0) {
        this.counter = counter;
        this.tima = 0;
        this.tma = 0;
        this.tac = 0;
        this.reloadState = Tima.RUNNING;
        // The counter's state machine: 0 just reset (3 T-cycles to the first
        // step), 2 between steps; `cycles` is how far it is into the wait.
        this.divState = 2;
        this.divCycles = divCycles;
        this.refreshWatch();
    }

    sync(s) {
        this.counter = s.u16(this.counter);
        this.tima = s.u8(this.tima);
        this.tma = s.u8(this.tma);
        this.tac = s.u8(this.tac);
        this.reloadState = s.u8(this.reloadState);
        this.divState = s.u8(this.divState);
        this.divCycles = s.i32(this.divCycles);
        if (s.reading) this.refreshWatch();
    }

    get div() {
        return this.counter >> 8;
    }

    /** Advances by `cycles` CPU T-cycles. */
    run(cycles) {
        const gb = this.gb;
        const apu = this.apu;
        if (this.cpu.stopped) {
            if (gb.cgb) apu.pending += gb.doubleSpeed ? 2 : 4;
            return;
        }
        this.divCycles += cycles;
        if (this.divCycles <= 0) return;
        if (this.divState === 0) {
            this.divCycles -= 3;
            if (this.divCycles <= 0) {
                this.divState = 1;
                return;
            }
        } else if (this.divState === 2 && apu.pendingEnvelopeTick) {
            // An envelope step postponed by the last DIV event (double speed).
            apu.delayedEnvelopeTick();
        }
        for (;;) {
            if (this.reloadState === Tima.RELOADED) {
                this.reloadState = Tima.RUNNING;
            } else if (this.reloadState === Tima.RELOADING) {
                gb.io[0x0f] |= Interrupt.TIMER;
                this.reloadState = Tima.RELOADED;
            }
            this.setCounter((this.counter + 4) & 0xffff);
            apu.pending += gb.doubleSpeed ? 2 : 4;
            this.divCycles -= 4;
            if (this.divCycles <= 0) {
                this.divState = 2;
                return;
            }
            if (apu.pendingEnvelopeTick) apu.delayedEnvelopeTick();
        }
    }

    /**
     * Which counter bits clock something: TIMA's, the serial port's and the
     * APU's. Call when TAC, the serial clock or the speed changes.
     */
    refreshWatch() {
        const gb = this.gb;
        // (The serial port doesn't exist yet while the GameBoy is being built.)
        const serial = gb.serial ? gb.serial.mask : 0x80;
        this.watch = (this.tac & 4 ? TAC_BITS[this.tac & 3] : 0) | serial | (gb.doubleSpeed ? 0x2000 : 0x1000);
    }

    /** Sets the system counter, clocking what runs off its falling edges. */
    setCounter(value) {
        const old = this.counter;
        if ((old ^ value) & this.watch) this.#edges(old, value);
        this.counter = value;
    }

    #edges(old, value) {
        const gb = this.gb;
        const fallen = old & ~value;
        if (this.tac & 4 && fallen & TAC_BITS[this.tac & 3]) this.#increaseTima();
        if (fallen & gb.serial.mask) gb.serial.edge();
        // The APU's 512 Hz events: falling edges, and rising ones for the envelopes.
        const apuBit = gb.doubleSpeed ? 0x2000 : 0x1000;
        if (fallen & apuBit) gb.apu.divEvent();
        else if (~old & value & apuBit) gb.apu.divSecondaryEvent();
    }

    /** T-cycles (at least) before the timer can raise an interrupt. */
    get quietCycles() {
        if (this.reloadState !== Tima.RUNNING) return 0;
        if (!(this.tac & 4)) return Infinity;
        const period = TAC_BITS[this.tac & 3] * 2;
        return period - (this.counter & (period - 1)) + (255 - this.tima) * period;
    }

    readTima() {
        return this.reloadState === Tima.RELOADING ? 0 : this.tima;
    }

    writeDiv() {
        const apu = this.gb.apu;
        apu.duringDivWrite = true;
        this.setCounter(0);
        apu.duringDivWrite = false;
        this.divState = 0;
        this.divCycles = 0;
    }

    writeTima(value) {
        if (this.reloadState !== Tima.RELOADED) this.tima = value;
    }

    writeTma(value) {
        this.tma = value;
        if (this.reloadState !== Tima.RUNNING) this.tima = value;
    }

    /**
     * The enable bit is ANDed with the counter bit before edge detection, so
     * turning the timer off (or switching bits) while the bit is high clocks TIMA.
     */
    writeTac(value) {
        const old = this.tac;
        if (old & 4 && this.counter & TAC_BITS[old & 3]) {
            if (!(value & 4) || !(this.counter & TAC_BITS[value & 3])) this.#increaseTima();
        }
        this.tac = value;
        this.refreshWatch();
    }

    #increaseTima() {
        this.tima = (this.tima + 1) & 0xff;
        if (this.tima === 0) {
            this.tima = this.tma;
            this.reloadState = Tima.RELOADING;
        }
    }
}
