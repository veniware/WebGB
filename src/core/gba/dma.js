// Start timings (DMAxCNT_H bits 12-13).
export const Timing = { IMMEDIATE: 0, VBLANK: 1, HBLANK: 2, SPECIAL: 3 };

const SRC_MASK = [0x07ffffff, 0x0fffffff, 0x0fffffff, 0x0fffffff];
const DST_MASK = [0x07ffffff, 0x07ffffff, 0x07ffffff, 0x0fffffff];
const COUNT_MASK = [0x3fff, 0x3fff, 0x3fff, 0xffff];
// Cycles from the write that enables an immediate transfer to its start;
// the CPU runs on meanwhile, until it next uses the bus.
const START_DELAY = 2;

function isCart(region) {
    return region >= 8 && region <= 0xd;
}

/**
 * The four DMA channels. A transfer runs in one go when it starts (the CPU
 * is stopped meanwhile on hardware too) and its cycles are added to the bus.
 * Channels 1 and 2 feed the sound FIFOs; channel 3 serves the EEPROM.
 */
export class Dma {
    /**
     * @param {import("./bus.js").Bus} bus
     * @param {{ requestIrq: (bit: number) => void, eepromTransfer?: (count: number) => void,
     *     onSchedule?: (time: number) => void }} hooks
     */
    constructor(bus, hooks) {
        this.bus = bus;
        this.hooks = hooks;
        this.sad = new Int32Array(4);
        this.dad = new Int32Array(4);
        this.count = new Uint16Array(4);
        this.control = new Uint16Array(4);
        // Internal registers, latched when a channel is enabled.
        this.src = new Int32Array(4);
        this.dst = new Int32Array(4);
        this.remaining = new Uint32Array(4);
        // Each channel's last value read (returned for reads from the BIOS).
        this.latch = new Int32Array(4);
        this.reset();
    }

    reset() {
        // Immediate transfers waiting to start (channel bits), and when.
        this.pending = 0;
        this.nextEvent = Infinity;
        this.bus.dmaDue = Infinity;
        for (const array of [this.sad, this.dad, this.count, this.control, this.src, this.dst, this.remaining, this.latch]) {
            array.fill(0);
        }
    }

    sync(s) {
        for (const array of [this.sad, this.dad, this.count, this.control, this.src, this.dst, this.remaining, this.latch]) {
            s.bytes(array);
        }
    }

    read16(address) {
        const i = Math.floor((address - 0xb0) / 12);
        const offset = (address - 0xb0) % 12;
        // Only the control register is readable (-1: open bus).
        if (offset === 10) return this.control[i];
        return offset === 8 ? 0 : -1;
    }

    write16(address, value) {
        const i = Math.floor((address - 0xb0) / 12);
        switch ((address - 0xb0) % 12) {
            case 0: this.sad[i] = (this.sad[i] & ~0xffff) | value; break;
            case 2: this.sad[i] = (this.sad[i] & 0xffff) | (value << 16); break;
            case 4: this.dad[i] = (this.dad[i] & ~0xffff) | value; break;
            case 6: this.dad[i] = (this.dad[i] & 0xffff) | (value << 16); break;
            case 8: this.count[i] = value; break;
            default: this.#writeControl(i, value);
        }
    }

    #writeControl(i, value) {
        const wasOn = (this.control[i] & 0x8000) !== 0;
        this.control[i] = value & (i === 3 ? 0xffe0 : 0xf7e0);
        if (wasOn || !(value & 0x8000)) return;
        this.src[i] = this.sad[i] & SRC_MASK[i];
        this.dst[i] = this.dad[i] & DST_MASK[i];
        this.remaining[i] = (this.count[i] & COUNT_MASK[i]) || COUNT_MASK[i] + 1;
        if (((value >>> 12) & 3) === Timing.IMMEDIATE) this.#start(i, this.bus.cycles + START_DELAY);
    }

    /** Channel i starts at `time`, at the CPU's next bus access or event from then. */
    #start(i, time) {
        this.pending |= 1 << i;
        if (time < this.nextEvent) {
            this.nextEvent = time;
            this.bus.dmaDue = time;
            this.hooks.onSchedule?.(time);
        }
    }

    /** Runs the immediate transfers that are due (at the CPU's next bus access or event). */
    runPending() {
        const pending = this.pending;
        this.pending = 0;
        this.nextEvent = Infinity;
        this.bus.dmaDue = Infinity;
        for (let i = 0; i < 4; i++) {
            if (pending & (1 << i) && this.control[i] & 0x8000) this.#transfer(i);
        }
    }

    /** Starts the enabled channels waiting for `timing` (VBlank, HBlank). */
    trigger(timing) {
        for (let i = 0; i < 4; i++) {
            const control = this.control[i];
            if (control & 0x8000 && ((control >>> 12) & 3) === timing) this.#transfer(i);
        }
    }

    /** Video capture: DMA 3 in special timing runs in the HBlanks of lines 2-161, then stops. */
    videoCapture(line) {
        const control = this.control[3];
        if (!(control & 0x8000) || ((control >>> 12) & 3) !== Timing.SPECIAL) return;
        if (line < 162) this.#transfer(3);
        else this.control[3] &= ~0x8000;
    }

    /** A sound FIFO wants data: DMA 1 or 2 in special timing to its address. */
    soundRequest(fifoAddress) {
        for (let i = 1; i <= 2; i++) {
            const control = this.control[i];
            if (control & 0x8000 && ((control >>> 12) & 3) === Timing.SPECIAL && (this.dad[i] & 0x0fffffff) === fifoAddress) {
                this.#transfer(i, true);
            }
        }
    }

    #transfer(i, sound = false) {
        const bus = this.bus;
        const control = this.control[i];
        const wide = sound || (control & 0x0400) !== 0;
        const unit = wide ? 4 : 2;
        const dstMode = sound ? 2 : (control >>> 5) & 3;
        const srcMode = (control >>> 7) & 3;
        const dstStep = dstMode === 1 ? -unit : dstMode === 2 ? 0 : unit;
        let src = this.src[i];
        let dst = this.dst[i];
        // From the cartridge ROM, the source always increments.
        const fromRom = ((src >>> 24) & 0xf) >= 8 && ((src >>> 24) & 0xf) < 0xe;
        const srcStep = fromRom || srcMode === 0 || srcMode === 3 ? unit : srcMode === 1 ? -unit : 0;
        const count = sound ? 4 : this.remaining[i];
        if (i === 3 && this.hooks.eepromTransfer && (dst >>> 24) === 0x0d) this.hooks.eepromTransfer(count);
        const srcRegion = (src >>> 24) & 0xf;
        const dstRegion = (dst >>> 24) & 0xf;
        const n = wide ? bus.n32 : bus.n16;
        const s = wide ? bus.s32 : bus.s16;
        // From the cartridge to the cartridge, the first write continues the
        // read's access (sequential).
        const cartToCart = isCart(srcRegion) && isCart(dstRegion);
        if (isCart(srcRegion) || isCart(dstRegion)) bus.stopPrefetch();
        bus.cycles += 2 + n[srcRegion] + (cartToCart ? s[dstRegion] : n[dstRegion]) + (count - 1) * (s[srcRegion] + s[dstRegion]);
        const latch = this.latch;
        for (let k = 0; k < count; k++) {
            // Reads below 0x02000000 (the BIOS) give the last value instead.
            if (wide) {
                if (src >>> 0 >= 0x02000000) latch[i] = bus.dmaRead32(src);
                bus.dmaWrite32(dst, latch[i]);
            } else {
                if (src >>> 0 >= 0x02000000) {
                    const value = bus.dmaRead16(src);
                    latch[i] = value | (value << 16);
                }
                bus.dmaWrite16(dst, latch[i] >>> ((dst & 2) * 8));
            }
            src = (src + srcStep) | 0;
            dst = (dst + dstStep) | 0;
        }
        this.src[i] = src;
        this.dst[i] = dst;
        // Its last value stays on the bus until the CPU's next opcode fetch.
        bus.dmaValue = latch[i];
        if (control & 0x4000) this.hooks.requestIrq(8 + i);
        const timing = (control >>> 12) & 3;
        if (control & 0x0200 && timing !== Timing.IMMEDIATE) {
            // Repeat: reload the count (and the destination when it is "increment/reload").
            this.remaining[i] = (this.count[i] & COUNT_MASK[i]) || COUNT_MASK[i] + 1;
            if (dstMode === 3) this.dst[i] = this.dad[i] & DST_MASK[i];
        } else {
            this.control[i] &= ~0x8000;
        }
    }
}
