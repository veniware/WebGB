import { Mode } from "./cpu.js";

// No BIOS is shipped (Nintendo's is copyrighted): this one only holds the
// interrupt dispatcher every game relies on (the same six instructions as the
// original), and BIOS calls (SWI) are carried out in JavaScript.

const BIOS_CHECKSUM = 0xbaae187f;
// ArcTan's polynomial, after its first term.
const ARCTAN_TERMS = [0x91c, 0xfb6, 0x16aa, 0x2081, 0x3651, 0xa2f9];

/** A 16 KB BIOS image: vectors and the IRQ handler. */
export function createBios() {
    const bios = new Uint8Array(0x4000);
    const words = new Int32Array(bios.buffer);
    const at = (address, ...code) => code.forEach((word, i) => (words[(address >> 2) + i] = word));
    at(0x00, 0xea00001e); // reset: b 0x80 (unused: the game is started directly)
    at(0x04, 0xe1b0f00e); // undefined instruction: movs pc, lr
    at(0x08, 0xe1b0f00e); // SWI (calls not handled here): movs pc, lr
    at(0x0c, 0xe25ef004); // prefetch abort: subs pc, lr, #4
    at(0x10, 0xe25ef008); // data abort: subs pc, lr, #8
    at(0x18, 0xea000042); // IRQ: b 0x128
    at(0x1c, 0xe25ef004); // FIQ: subs pc, lr, #4
    at(0x80, 0xeafffffe); // reset: hang
    at(0x128,
        0xe92d500f, // stmfd sp!, {r0-r3, r12, lr}
        0xe3a00301, // mov r0, #0x04000000
        0xe28fe000, // add lr, pc, #0
        0xe510f004, // ldr pc, [r0, #-4]    (the game's handler, at 0x03007FFC)
        0xe8bd500f, // ldmfd sp!, {r0-r3, r12, lr}
        0xe25ef004, // subs pc, lr, #4
    );
    // What BIOS reads return after an interrupt (the word the pipeline holds then).
    at(0x144, 0xe55ec002);
    return bios;
}

// sin(i * 2pi / 256) in 1.14 fixed point, as the BIOS's table.
const SINE = Int16Array.from({ length: 256 }, (_, i) => Math.round(Math.sin((i * Math.PI) / 128) * 0x4000));

/**
 * BIOS calls in JavaScript (high-level emulation), after GBATEK and mGBA.
 * @param {import('./gba.js').Gba} gba
 */
export function createHleBios(gba) {
    const { bus } = gba;
    const read8 = (a) => bus.read8(a);
    const read16 = (a) => bus.read16(a);
    const read32 = (a) => bus.read32(a);
    const write8 = (a, v) => bus.write8(a, v);
    const write16 = (a, v) => bus.write16(a, v);
    const write32 = (a, v) => bus.write32(a, v);
    // Cycles the current call takes inside the BIOS.
    let stall = 0;

    /** The BIOS's interrupt flags for IntrWait, which IRQ handlers set. */
    const INTR_CHECK = 0x03007ff8;

    function intrWait(cpu, discard, flags) {
        gba.irq.setMasterEnable(true);
        // A resumed wait (see below) doesn't discard what the interrupt just flagged.
        if (discard && !gba.biosWaiting) write16(INTR_CHECK, read16(INTR_CHECK) & ~flags);
        const pending = read16(INTR_CHECK) & flags;
        if (pending) {
            gba.biosWaiting = false;
            write16(INTR_CHECK, read16(INTR_CHECK) & ~pending);
            return;
        }
        // Halt, and run the SWI again once an interrupt has been handled.
        gba.biosWaiting = true;
        cpu.branch(cpu.pc - (cpu.thumb ? 2 : 4));
        gba.halt();
    }

    // Like the BIOS, leaves intermediate values in r1 and r3 (some games rely
    // on that, and the test suites check it).
    function arcTan(value, r) {
        const a = -((Math.imul(value, value)) >> 14);
        stall = 37 + mulWait(Math.imul(value, value)) + mulWait(Math.imul(0xa9, a));
        let b = ((Math.imul(0xa9, a)) >> 14) + 0x390;
        for (const add of ARCTAN_TERMS) {
            stall += mulWait(Math.imul(b, a));
            b = ((Math.imul(b, a)) >> 14) + add;
        }
        r[1] = a;
        r[3] = b;
        return (Math.imul(value, b) >> 16) << 16 >> 16;
    }

    function arcTan2(x, y, r) {
        const div = (a, b) => (b === 0 ? 0 : Math.trunc(a / b) | 0);
        stall = 11;
        if (!y) return x >= 0 ? 0 : 0x8000;
        if (!x) return y >= 0 ? 0x4000 : 0xc000;
        if (y >= 0) {
            if (x >= 0) {
                if (x >= y) return arcTan(div(y << 14, x), r);
            } else if (-x >= y) return arcTan(div(y << 14, x), r) + 0x8000;
            return 0x4000 - arcTan(div(x << 14, y), r);
        }
        if (x <= 0) {
            if (-x > -y) return arcTan(div(y << 14, x), r) + 0x8000;
        } else if (x >= -y) return arcTan(div(y << 14, x), r) + 0x10000;
        return 0xc000 - arcTan(div(x << 14, y), r);
    }

    // Addresses aren't aligned first: like the BIOS's LDRH/LDM, the bus does
    // that (an odd LDRH rotates; 8-bit SRAM sees the whole address). Copies
    // from the BIOS area are refused. Returns the cycles of the BIOS loop.
    function cpuSet(src, dst, control) {
        if ((src >>> 0) < 0x02000000) return 0;
        const count = control & 0x1fffff;
        const fill = (control & 0x01000000) !== 0;
        const load16 = (a) => (a & 1 ? read16(a) >>> 8 : read16(a));
        if (control & 0x04000000) {
            const value = fill ? read32(src) : 0;
            for (let i = 0; i < count; i++) write32(dst + i * 4, fill ? value : read32(src + i * 4));
        } else {
            const value = fill ? load16(src) : 0;
            for (let i = 0; i < count; i++) write16(dst + i * 2, fill ? value : load16(src + i * 2));
        }
        return 7 * count;
    }

    function cpuFastSet(src, dst, control) {
        if ((src >>> 0) < 0x02000000) return 0;
        const count = ((control & 0x1fffff) + 7) & ~7;
        const fill = (control & 0x01000000) !== 0;
        const value = fill ? read32(src) : 0;
        for (let i = 0; i < count; i++) write32(dst + i * 4, fill ? value : read32(src + i * 4));
        return 48 + (count >> 3) * 7;
    }

    // Cycles the BIOS takes for a multiplication by `value` (as in mGBA).
    function mulWait(value) {
        if ((value & 0xffffff00) === (0xffffff00 | 0) || !(value & 0xffffff00)) return 1;
        if ((value & 0xffff0000) === (0xffff0000 | 0) || !(value & 0xffff0000)) return 2;
        if ((value & 0xff000000) === (0xff000000 | 0) || !(value & 0xff000000)) return 3;
        return 4;
    }

    /** Integer square root the way the BIOS does it; `stall` gets its cycles. */
    function sqrt(x) {
        x >>>= 0;
        if (!x) {
            stall = 53;
            return 0;
        }
        let cycles = 15;
        let upper = x;
        let bound = 1;
        while (bound < upper) {
            upper >>>= 1;
            bound = (bound << 1) >>> 0;
            cycles += 6;
        }
        for (;;) {
            cycles += 6;
            upper = x;
            let accum = 0;
            let lower = bound;
            for (;;) {
                cycles += 5;
                const oldLower = lower;
                if (lower <= upper >>> 1) lower = (lower << 1) >>> 0;
                if (oldLower >= upper >>> 1) break;
            }
            for (;;) {
                cycles += 8;
                accum = (accum << 1) >>> 0;
                if (upper >= lower) {
                    accum++;
                    upper -= lower;
                }
                if (lower === bound) break;
                lower >>>= 1;
            }
            const oldBound = bound;
            bound = (bound + accum) / 2 >>> 0;
            if (bound >= oldBound) {
                bound = oldBound;
                break;
            }
        }
        stall = cycles;
        return bound;
    }

    function bgAffineSet(src, dst, count) {
        for (let i = 0; i < count; i++) {
            const ox = read32(src);
            const oy = read32(src + 4);
            const cx = (read16(src + 8) << 16) >> 16;
            const cy = (read16(src + 10) << 16) >> 16;
            const sx = (read16(src + 12) << 16) >> 16;
            const sy = (read16(src + 14) << 16) >> 16;
            const theta = read16(src + 16) >>> 8;
            src += 20;
            const sin = SINE[theta];
            const cos = SINE[(theta + 64) & 0xff];
            const pa = Math.imul(sx, cos) >> 14;
            const pb = -(Math.imul(sx, sin) >> 14);
            const pc = Math.imul(sy, sin) >> 14;
            const pd = Math.imul(sy, cos) >> 14;
            write16(dst, pa);
            write16(dst + 2, pb);
            write16(dst + 4, pc);
            write16(dst + 6, pd);
            write32(dst + 8, ox - (Math.imul(pa, cx) + Math.imul(pb, cy)));
            write32(dst + 12, oy - (Math.imul(pc, cx) + Math.imul(pd, cy)));
            dst += 16;
        }
    }

    function objAffineSet(src, dst, count, stride) {
        for (let i = 0; i < count; i++) {
            const sx = (read16(src) << 16) >> 16;
            const sy = (read16(src + 2) << 16) >> 16;
            const theta = read16(src + 4) >>> 8;
            src += 8;
            const sin = SINE[theta];
            const cos = SINE[(theta + 64) & 0xff];
            write16(dst, Math.imul(sx, cos) >> 14);
            write16(dst + stride, -(Math.imul(sx, sin) >> 14));
            write16(dst + stride * 2, Math.imul(sy, sin) >> 14);
            write16(dst + stride * 3, Math.imul(sy, cos) >> 14);
            dst += stride * 4;
        }
    }

    function bitUnpack(src, dst, info) {
        let length = read16(info);
        const srcWidth = read8(info + 2);
        const dstWidth = read8(info + 3);
        const offsetWord = read32(info + 4);
        const offset = offsetWord & 0x7fffffff;
        const zeroToo = offsetWord < 0;
        let out = 0;
        let outBits = 0;
        const mask = (1 << srcWidth) - 1;
        while (length-- > 0) {
            const byte = read8(src++);
            for (let bit = 0; bit < 8; bit += srcWidth) {
                let value = (byte >> bit) & mask;
                if (value || zeroToo) value += offset;
                out |= (value & (dstWidth === 32 ? -1 : (1 << dstWidth) - 1)) << outBits;
                outBits += dstWidth;
                if (outBits >= 32) {
                    write32(dst, out);
                    dst += 4;
                    out = 0;
                    outBits = 0;
                }
            }
        }
    }

    /** Decompressors write bytes, or halfwords for video memory (8-bit writes don't work there). */
    function writer(dst, halfwords) {
        let pending = 0;
        let odd = false;
        return {
            put(byte) {
                if (!halfwords) {
                    write8(dst++, byte);
                    return;
                }
                if (odd) {
                    write16(dst - 1, pending | (byte << 8));
                } else {
                    pending = byte;
                }
                odd = !odd;
                dst++;
            },
            /** Bytes written so far start at `dst - n`; for LZ77 back-references. */
            peek(back) {
                const address = dst - back;
                if (halfwords && odd && back === 1) return pending;
                return read8(address);
            },
        };
    }

    function lz77(src, dst, halfwords) {
        const header = read32(src);
        let size = header >>> 8;
        src += 4;
        const out = writer(dst, halfwords);
        while (size > 0) {
            const flags = read8(src++);
            for (let bit = 7; bit >= 0 && size > 0; bit--) {
                if (flags & (1 << bit)) {
                    const b0 = read8(src++);
                    const b1 = read8(src++);
                    const length = (b0 >> 4) + 3;
                    const distance = (((b0 & 0xf) << 8) | b1) + 1;
                    for (let i = 0; i < length && size > 0; i++, size--) out.put(out.peek(distance));
                } else {
                    out.put(read8(src++));
                    size--;
                }
            }
        }
    }

    function runLength(src, dst, halfwords) {
        const header = read32(src);
        let size = header >>> 8;
        src += 4;
        const out = writer(dst, halfwords);
        while (size > 0) {
            const flag = read8(src++);
            if (flag & 0x80) {
                const byte = read8(src++);
                for (let i = (flag & 0x7f) + 3; i > 0 && size > 0; i--, size--) out.put(byte);
            } else {
                for (let i = (flag & 0x7f) + 1; i > 0 && size > 0; i--, size--) out.put(read8(src++));
            }
        }
    }

    function huffman(src, dst) {
        const header = read32(src);
        const bits = header & 0xf;
        let size = header >>> 8;
        const treeSize = read8(src + 4);
        const treeStart = src + 5;
        let stream = src + 4 + (treeSize + 1) * 2;
        let out = 0;
        let outBits = 0;
        let nodeAddress = treeStart;
        let node = read8(nodeAddress);
        while (size > 0) {
            const word = read32(stream);
            stream += 4;
            for (let bit = 31; bit >= 0; bit--) {
                const right = (word >>> bit) & 1;
                const offset = node & 0x3f;
                const childAddress = ((nodeAddress & ~1) + offset * 2 + 2) + right;
                const leaf = node & (right ? 0x40 : 0x80);
                if (leaf) {
                    out |= read8(childAddress) << outBits;
                    outBits += bits;
                    nodeAddress = treeStart;
                    node = read8(nodeAddress);
                    if (outBits === 32) {
                        write32(dst, out);
                        dst += 4;
                        size -= 4;
                        out = 0;
                        outBits = 0;
                        if (size <= 0) return;
                    }
                } else {
                    nodeAddress = childAddress;
                    node = read8(nodeAddress);
                }
            }
        }
    }

    function unfilter(src, dst, width, halfwords) {
        const header = read32(src);
        let size = header >>> 8;
        src += 4;
        let value = 0;
        if (width === 16) {
            while (size > 0) {
                value = (value + read16(src)) & 0xffff;
                write16(dst, value);
                src += 2;
                dst += 2;
                size -= 2;
            }
            return;
        }
        const out = writer(dst, halfwords);
        while (size-- > 0) {
            value = (value + read8(src++)) & 0xff;
            out.put(value);
        }
    }

    function registerRamReset(flags) {
        const fill = (start, length) => {
            for (let i = 0; i < length; i += 4) write32(start + i, 0);
        };
        if (flags & 0x01) fill(0x02000000, 0x40000);
        if (flags & 0x02) fill(0x03000000, 0x7e00);
        if (flags & 0x04) fill(0x05000000, 0x400);
        if (flags & 0x08) fill(0x06000000, 0x18000);
        if (flags & 0x10) fill(0x07000000, 0x400);
        if (flags & 0x80) {
            gba.write16(0x000, 0x0080);
            for (let a = 0x004; a < 0x060; a += 2) gba.write16(a, 0);
            for (let a = 0x0b0; a < 0x100; a += 2) gba.write16(a, 0);
            for (let a = 0x100; a < 0x110; a += 2) gba.write16(a, 0);
            gba.write16(0x200, 0);
            gba.write16(0x202, 0xffff);
            gba.write16(0x208, 0);
            gba.write16(0x020, 0x100);
            gba.write16(0x026, 0x100);
            gba.write16(0x030, 0x100);
            gba.write16(0x036, 0x100);
        }
        if (flags & 0x40) {
            for (let a = 0x060; a < 0x0b0; a += 2) gba.write16(a, 0);
            gba.write16(0x088, 0x200);
        }
    }

    /** @returns {boolean} whether the call was handled. */
    return function swi(cpu, comment) {
        // BIOS reads return this after a call on hardware.
        bus.biosLatch = 0xe3a02004 | 0;
        stall = 0;
        // The BIOS's entry and exit (as measured on hardware; mGBA's figures),
        // then the call's own work.
        const region = (cpu.pc >>> 24) & 0xf;
        if (!call(cpu, comment)) return false;
        bus.idle(42 + bus.n16[region] + stall);
        // Returning from the BIOS refills the pipeline.
        cpu.branch(cpu.pc);
        return true;
    };

    function call(cpu, comment) {
        const r = cpu.r;
        switch (comment) {
            case 0x00: // SoftReset
                gba.softReset(read8(0x03007ffa) !== 0);
                return true;
            case 0x01: registerRamReset(r[0]); return true;
            case 0x02: gba.halt(); return true;
            case 0x03: gba.halt(); return true; // Stop: treated as Halt
            case 0x04: intrWait(cpu, r[0] !== 0, r[1]); return true;
            case 0x05: intrWait(cpu, true, 1); return true;
            case 0x06: case 0x07: { // Div, DivArm
                const [num, den] = comment === 0x06 ? [r[0], r[1]] : [r[1], r[0]];
                if (den === 0) {
                    r[0] = num < 0 ? -1 : 1;
                    r[1] = num;
                    r[3] = 1;
                } else {
                    const quotient = Math.trunc(num / den) | 0;
                    r[0] = quotient;
                    r[1] = (num - Math.imul(quotient, den)) | 0;
                    r[3] = Math.abs(quotient) | 0;
                }
                stall = 11 + 13 * Math.max(1, Math.clz32(den) - Math.clz32(num));
                return true;
            }
            case 0x08: r[0] = sqrt(r[0]); return true;
            case 0x09: r[0] = arcTan(r[0], r); return true;
            case 0x0a: {
                r[0] = arcTan2(r[0], r[1], r) & 0xffff;
                r[3] = 0x170;
                return true;
            }
            case 0x0b: stall = cpuSet(r[0], r[1], r[2]); return true;
            case 0x0c: stall = cpuFastSet(r[0], r[1], r[2]); return true;
            case 0x0d: r[0] = BIOS_CHECKSUM | 0; return true;
            case 0x0e: bgAffineSet(r[0], r[1], r[2]); return true;
            case 0x0f: objAffineSet(r[0], r[1], r[2], r[3]); return true;
            case 0x10: bitUnpack(r[0], r[1], r[2]); return true;
            case 0x11: lz77(r[0], r[1], false); return true;
            case 0x12: lz77(r[0], r[1], true); return true;
            case 0x13: huffman(r[0], r[1]); return true;
            case 0x14: runLength(r[0], r[1], false); return true;
            case 0x15: runLength(r[0], r[1], true); return true;
            case 0x16: unfilter(r[0], r[1], 8, false); return true;
            case 0x17: unfilter(r[0], r[1], 8, true); return true;
            case 0x18: unfilter(r[0], r[1], 16, true); return true;
            case 0x19: gba.write16(0x088, (gba.read16(0x088) & ~0x3ff) | (r[0] ? 0x200 : 0)); return true;
            case 0x1f: { // MidiKey2Freq
                const frequency = read32(r[0] + 4) >>> 0;
                r[0] = Math.floor(frequency / 2 ** ((180 - r[1] - r[2] / 256) / 12)) | 0;
                return true;
            }
            case 0x25: r[0] = 1; return true; // MultiBoot: no link cable, fails
            case 0x26: gba.softReset(false); return true; // HardReset
            case 0x27: gba.halt(); return true; // CustomHalt
            case 0x1a: case 0x1b: case 0x1c: case 0x1d: case 0x1e:
            case 0x20: case 0x21: case 0x22: case 0x23: case 0x24:
            case 0x28: case 0x29: case 0x2a:
                // The BIOS sound driver (rarely used by games) isn't emulated.
                return true;
            default:
                return false;
        }
    }
}

/** Registers as the BIOS leaves them when it starts the game. */
export function bootState(cpu) {
    cpu.reset();
    cpu.mode = Mode.SVC;
    cpu.switchMode(Mode.IRQ);
    cpu.r[13] = 0x03007fa0;
    cpu.switchMode(Mode.SVC);
    cpu.r[13] = 0x03007fe0;
    cpu.switchMode(Mode.SYS);
    cpu.r[13] = 0x03007f00;
    cpu.irqDisable = false;
    cpu.fiqDisable = false;
    cpu.branch(0x08000000);
}
