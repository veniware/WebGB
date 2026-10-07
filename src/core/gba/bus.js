// Memory regions (address bits 24-27).
export const Region = {
    BIOS: 0x0, EWRAM: 0x2, IWRAM: 0x3, IO: 0x4, PALETTE: 0x5, VRAM: 0x6, OAM: 0x7,
    ROM0: 0x8, ROM0_HI: 0x9, ROM1: 0xa, ROM1_HI: 0xb, ROM2: 0xc, ROM2_HI: 0xd, SRAM: 0xe, SRAM_HI: 0xf,
};

// ROM wait states from WAITCNT: first (non-sequential) and sequential access.
const ROM_N = [4, 3, 2, 8];
const ROM_S = [[2, 1], [4, 1], [8, 1]];

/**
 * The GBA's memory bus: the memory map, access rules (8/16/32-bit, mirrors,
 * BIOS protection, open bus) and cycle counting with the wait states of
 * each region. Accesses add their cycles to `cycles`.
 */
export class Bus {
    /**
     * @param {{ rom: Uint8Array, bios: Uint8Array, io: { read16: (addr: number) => number,
     *     write16: (addr: number, value: number) => void, read8?: (addr: number) => number,
     *     write8: (addr: number, value: number) => void }, ppu: object, backup: object, gpio?: object }} parts
     */
    constructor({ rom, bios, io, ppu, backup, gpio }) {
        // ROMs are padded to a multiple of 4 bytes so they can be read as words.
        const size = (rom.length + 3) & ~3;
        this.rom = new Uint8Array(size);
        this.rom.set(rom);
        this.rom16 = new Uint16Array(this.rom.buffer, 0, size >> 1);
        this.rom32 = new Int32Array(this.rom.buffer, 0, size >> 2);
        this.romSize = rom.length;
        this.bios = bios;
        this.bios16 = new Uint16Array(bios.buffer);
        this.bios32 = new Int32Array(bios.buffer);
        this.ewram = new Uint8Array(0x40000);
        this.ewram16 = new Uint16Array(this.ewram.buffer);
        this.ewram32 = new Int32Array(this.ewram.buffer);
        this.iwram = new Uint8Array(0x8000);
        this.iwram16 = new Uint16Array(this.iwram.buffer);
        this.iwram32 = new Int32Array(this.iwram.buffer);
        this.io = io;
        this.ppu = ppu;
        this.backup = backup;
        this.gpio = gpio ?? null;
        this.debugText = new Uint8Array(256);
        this.debugEnabled = false;
        /** @type {((text: string) => void) | null} */
        this.onDebug = null;
        /** @type {import('./cpu.js').Arm7 | null} */
        this.cpu = null;
        // Cycles of 16-bit and 32-bit accesses per region, non-sequential and sequential.
        this.n16 = new Uint8Array(16);
        this.s16 = new Uint8Array(16);
        this.n32 = new Uint8Array(16);
        this.s32 = new Uint8Array(16);
        // For idle-loop detection (idle.js): counts of writes, and of reads of
        // what changes without the CPU or an event (timers, sound, EEPROM).
        this.writes = 0;
        this.volatileReads = 0;
        this.reset();
    }

    reset() {
        this.ewram.fill(0);
        this.iwram.fill(0);
        this.cycles = 0;
        // The pipeline refills after a jump; the next fetch is non-sequential
        // after a data access.
        this.branched = true;
        this.nonseq = false;
        // Prefetch buffer: the next opcode it holds or fetches, how many it
        // holds, cycles until the one in progress arrives (as of pfTime).
        this.pfActive = false;
        this.pfHead = 0;
        this.pfCount = 0;
        this.pfCountdown = 0;
        this.pfTime = 0;
        // The last opcode the BIOS fetched; what BIOS reads return outside it.
        this.biosLatch = 0xe129f000;
        this.prefetch = false;
        this.setWaitControl(0);
    }

    sync(s) {
        s.bytes(this.ewram);
        s.bytes(this.iwram);
        this.biosLatch = s.u32(this.biosLatch >>> 0) | 0;
        this.waitControl = s.u16(this.waitControl);
        this.setWaitControl(this.waitControl);
        for (const flag of ["branched", "nonseq", "pfActive"]) this[flag] = s.bool(this[flag]);
        this.pfHead = s.i32(this.pfHead);
        this.pfCount = s.u8(this.pfCount);
        this.pfCountdown = s.f64(this.pfCountdown);
        this.pfTime = s.f64(this.pfTime);
    }

    /** WAITCNT: wait states of the ROM areas and SRAM, and the prefetch buffer. */
    setWaitControl(value) {
        this.waitControl = value;
        const set = (region, n16, s16, n32 = n16, s32 = s16) => {
            this.n16[region] = n16;
            this.s16[region] = s16;
            this.n32[region] = n32;
            this.s32[region] = s32;
        };
        for (let region = 0; region < 16; region++) set(region, 1, 1);
        set(Region.EWRAM, 3, 3, 6, 6);
        set(Region.PALETTE, 1, 1, 2, 2);
        set(Region.VRAM, 1, 1, 2, 2);
        const sram = 1 + ROM_N[value & 3];
        set(Region.SRAM, sram, sram);
        set(Region.SRAM_HI, sram, sram);
        for (let ws = 0; ws < 3; ws++) {
            const n = 1 + ROM_N[(value >> (2 + ws * 3)) & 3];
            const s = 1 + ROM_S[ws][(value >> (4 + ws * 3)) & 1];
            set(Region.ROM0 + ws * 2, n, s, n + s, s * 2);
            set(Region.ROM0 + ws * 2 + 1, n, s, n + s, s * 2);
        }
        this.prefetch = (value & 0x4000) !== 0;
        this.pfActive = false;
    }

    /** Internal CPU cycles. */
    idle(cycles) {
        this.cycles += cycles;
    }

    /**
     * Moves time forward without bus activity (skipped idle-loop passes, from
     * a jump: the prefetch buffer starts over after it anyway).
     */
    skip(cycles) {
        this.cycles += cycles;
    }

    // --- Opcode fetches -------------------------------------------------------------

    /**
     * Cycles of an opcode fetch. The fetch stands for the pipeline's prefetch
     * two opcodes ahead; after a jump the pipeline refills first (2S + 1N in
     * all), after a data access the fetch is non-sequential.
     */
    #fetchCycles(n, s) {
        if (this.branched) {
            this.branched = false;
            this.nonseq = false;
            this.cycles += n + s * 2;
        } else if (this.nonseq) {
            this.nonseq = false;
            this.cycles += n;
        } else {
            this.cycles += s;
        }
    }

    /**
     * The prefetch buffer (WAITCNT bit 14) reads opcodes ahead from the
     * cartridge while the CPU doesn't use the bus; a buffered opcode takes one
     * cycle. Worked out lazily from the time since the last fetch (any ROM data
     * access in between stops the buffer).
     */
    #prefetchFetch(address, n, s, width) {
        if (this.branched || !this.pfActive || address !== this.pfHead) {
            // Miss: the CPU reads the opcode itself, then the buffer starts.
            this.cycles += this.branched ? n + s * 2 : this.nonseq || !this.pfActive ? n : s;
            this.branched = false;
            this.nonseq = false;
            this.pfActive = true;
            this.pfHead = (address + width) | 0;
            this.pfCount = 0;
            this.pfCountdown = s;
            this.pfTime = this.cycles;
            return;
        }
        this.nonseq = false;
        const capacity = width === 2 ? 8 : 4;
        let count = this.pfCount;
        let countdown = this.pfCountdown - (this.cycles - this.pfTime);
        while (countdown <= 0 && count < capacity) {
            count++;
            countdown += s;
        }
        if (count === capacity && countdown <= 0) countdown = s;
        this.pfHead = (address + width) | 0;
        if (count > 0) {
            this.pfCount = count - 1;
            this.pfCountdown = countdown;
            this.pfTime = this.cycles;
            this.cycles += 1;
        } else {
            // The opcode is on its way: wait for it.
            this.cycles += countdown;
            this.pfCount = 0;
            this.pfCountdown = s;
            this.pfTime = this.cycles;
        }
    }

    /** Cartridge opcode fetches (cycles, then the opcode). */
    #romFetchCycles(address, region, n, s, width) {
        if (this.prefetch) this.#prefetchFetch(address, n, s, width);
        else {
            // The cartridge bus restarts at each 128 KB block.
            if ((address & 0x1ffff) === 0) this.nonseq = true;
            this.#fetchCycles(n, s);
        }
    }

    fetch16(address) {
        const region = (address >>> 24) & 0xf;
        if (region >= Region.ROM0 && region <= Region.ROM2_HI) {
            this.#romFetchCycles(address, region, this.n16[region], this.s16[region], 2);
            const offset = address & 0x1fffffe;
            if (offset < this.romSize && this.gpio === null && region !== Region.ROM2_HI) return this.rom16[offset >> 1];
            return this.#readRom16(address);
        }
        this.#fetchCycles(this.n16[region], this.s16[region]);
        if (region === Region.BIOS) {
            // BIOS reads from outside return the last opcode it fetched.
            const op = this.bios16[(address & 0x3fff) >> 1];
            this.biosLatch = op | (op << 16);
            return op;
        }
        return this.#read16(address);
    }

    fetch32(address) {
        const region = (address >>> 24) & 0xf;
        if (region >= Region.ROM0 && region <= Region.ROM2_HI) {
            this.#romFetchCycles(address, region, this.n32[region], this.s32[region], 4);
            const offset = address & 0x1fffffc;
            if (offset < this.romSize && this.gpio === null && region !== Region.ROM2_HI) return this.rom32[offset >> 2];
            return this.#read32(address & ~3);
        }
        this.#fetchCycles(this.n32[region], this.s32[region]);
        if (region === Region.BIOS) {
            this.biosLatch = this.bios32[(address & 0x3fff) >> 2];
            return this.biosLatch;
        }
        return this.#read32(address);
    }

    /** Opcodes the pipeline reads again after a jump (their cycles are counted by the next fetch). */
    peekCode16(address) {
        const region = (address >>> 24) & 0xf;
        if (region === Region.BIOS) return this.bios16[(address & 0x3fff) >> 1];
        if (region === Region.ROM2_HI && this.backup.eeprom) return 0;
        return this.#read16(address & ~1);
    }

    peekCode32(address) {
        const region = (address >>> 24) & 0xf;
        if (region === Region.BIOS) return this.bios32[(address & 0x3fff) >> 2];
        if (region === Region.ROM2_HI && this.backup.eeprom) return 0;
        return this.#read32(address & ~3);
    }

    // --- Data accesses ------------------------------------------------------------

    /** Cycles of a data access; the next opcode fetch is non-sequential. */
    #access(address, region, n, s, sequential) {
        if (region >= Region.ROM0) {
            // The cartridge bus is taken: the prefetch buffer stops.
            this.pfActive = false;
            if ((address & 0x1ffff) === 0) sequential = false;
        }
        this.cycles += sequential ? s : n;
        this.nonseq = true;
    }

    read8(address) {
        const region = (address >>> 24) & 0xf;
        this.#access(address, region, this.n16[region], 0, false);
        switch (region) {
            case Region.BIOS:
                if (address >= 0x4000) return (this.#openBus() >>> ((address & 3) * 8)) & 0xff;
                return this.#readBios32(address) >>> ((address & 3) * 8) & 0xff;
            case Region.EWRAM: return this.ewram[address & 0x3ffff];
            case Region.IWRAM: return this.iwram[address & 0x7fff];
            case Region.IO: return (this.#readIo16(address & ~1) >>> ((address & 1) * 8)) & 0xff;
            case Region.PALETTE: return this.ppu.palette[address & 0x3ff];
            case Region.VRAM: return this.ppu.vram[vramIndex(address)];
            case Region.OAM: return this.ppu.oam[address & 0x3ff];
            case Region.SRAM:
            case Region.SRAM_HI:
                return this.backup.read8(address & 0xffff);
            default: {
                if (region >= Region.ROM0) {
                    const offset = address & 0x1ffffff;
                    if (this.gpio?.readable && offset >= 0xc4 && offset < 0xca) return this.gpio.read(offset) & 0xff;
                    return offset < this.romSize ? this.rom[offset] : ((address >>> 1) >>> ((address & 1) * 8)) & 0xff;
                }
                return (this.#openBus() >>> ((address & 3) * 8)) & 0xff;
            }
        }
    }

    read16(address, sequential = false) {
        const region = (address >>> 24) & 0xf;
        this.#access(address, region, this.n16[region], this.s16[region], sequential);
        // SRAM has an 8-bit bus: wider reads repeat the addressed byte.
        if (region >= Region.SRAM) return this.backup.read8(address & 0xffff) * 0x0101;
        return this.#read16(address & ~1);
    }

    read32(address, sequential = false) {
        const region = (address >>> 24) & 0xf;
        this.#access(address, region, this.n32[region], this.s32[region], sequential);
        if (region >= Region.SRAM) return Math.imul(this.backup.read8(address & 0xffff), 0x01010101);
        return this.#read32(address & ~3);
    }

    #read16(address) {
        switch ((address >>> 24) & 0xf) {
            case Region.BIOS:
                if (address >= 0x4000) return (this.#openBus() >>> ((address & 2) * 8)) & 0xffff;
                return (this.#readBios32(address) >>> ((address & 2) * 8)) & 0xffff;
            case Region.EWRAM: return this.ewram16[(address & 0x3ffff) >> 1];
            case Region.IWRAM: return this.iwram16[(address & 0x7fff) >> 1];
            case Region.IO: return this.#readIo16(address);
            case Region.PALETTE: return this.ppu.palette16[(address & 0x3ff) >> 1];
            case Region.VRAM: return this.ppu.vram16[vramIndex(address) >> 1];
            case Region.OAM: return this.ppu.oam16[(address & 0x3ff) >> 1];
            case Region.SRAM:
            case Region.SRAM_HI:
                return this.backup.read8(address & 0xffff) * 0x0101;
            default: return this.#readRom16(address);
        }
    }

    #read32(address) {
        switch ((address >>> 24) & 0xf) {
            case Region.BIOS:
                if (address >= 0x4000) return this.#openBus(address);
                return this.#readBios32(address);
            case Region.EWRAM: return this.ewram32[(address & 0x3ffff) >> 2];
            case Region.IWRAM: return this.iwram32[(address & 0x7fff) >> 2];
            case Region.IO: return this.#readIo16(address) | (this.#readIo16(address + 2) << 16);
            case Region.PALETTE: return this.ppu.palette32[(address & 0x3ff) >> 2];
            case Region.VRAM: return this.ppu.vram32[vramIndex(address) >> 2];
            case Region.OAM: return this.ppu.oam32[(address & 0x3ff) >> 2];
            case Region.SRAM:
            case Region.SRAM_HI:
                return Math.imul(this.backup.read8(address & 0xffff), 0x01010101);
            default:
                if (((address >>> 24) & 0xf) >= Region.ROM0) {
                    return this.#readRom16(address) | (this.#readRom16(address + 2) << 16);
                }
                return this.#openBus(address);
        }
    }

    #readRom16(address) {
        const region = (address >>> 24) & 0xf;
        if (region < Region.ROM0) return (this.#openBus() >>> ((address & 2) * 8)) & 0xffff;
        if (region === Region.ROM2_HI && this.backup.eeprom && this.backup.isEeprom(address, this.romSize)) {
            this.volatileReads++;
            return this.backup.readEeprom();
        }
        const offset = address & 0x1fffffe;
        if (this.gpio?.readable && offset >= 0xc4 && offset < 0xca) return this.gpio.read(offset);
        if (offset < this.romSize) return this.rom16[offset >> 1];
        // Past the end of the ROM the cartridge bus returns the address.
        return (address >>> 1) & 0xffff;
    }

    /** I/O registers; write-only and unused ones read as open bus (-1 from `io`). */
    #readIo16(address) {
        const offset = address & 0xfffffe;
        if ((offset >= 0x60 && offset < 0xb0) || (offset >= 0x100 && offset < 0x110)) this.volatileReads++;
        const value = offset < 0x400 ? this.io.read16(offset) : offset >= 0xfff600 ? this.#readDebug(address) : -1;
        return value >= 0 ? value : (this.#openBus() >>> ((address & 2) * 8)) & 0xffff;
    }

    /** BIOS memory can only be read while executing in it. */
    #readBios32(address) {
        if (this.cpu && (this.cpu.pc >>> 0) < 0x4000) return this.bios32[(address & 0x3fff) >> 2];
        return this.biosLatch;
    }

    /**
     * mGBA's debug output (0x04FFF600: text, 0x04FFF700: print, 0x04FFF780:
     * enable), which test ROMs use to report results; passed to `onDebug`.
     */
    #readDebug(address) {
        return (address & 0xfffffe) === 0xfff780 && this.debugEnabled ? 0x1dea : -1;
    }

    #writeDebug(address, value) {
        const offset = address & 0xffffff;
        if (offset === 0xfff780) {
            this.debugEnabled = value === 0xde;
        } else if (offset === 0xfff781) {
            this.debugEnabled = this.debugEnabled && value === 0xc0;
        } else if (offset >= 0xfff600 && offset < 0xfff700) {
            this.debugText[offset - 0xfff600] = value;
        } else if (offset === 0xfff701 && value & 1 && this.debugEnabled) {
            const end = this.debugText.indexOf(0);
            this.onDebug?.(new TextDecoder().decode(this.debugText.subarray(0, end < 0 ? 256 : end)));
            this.debugText.fill(0);
        }
    }

    /**
     * Unmapped reads return the last value on the bus: the opcode the CPU
     * prefetched (two instructions ahead). In Thumb state the two halves of
     * the 32-bit bus depend on the memory the code runs from (GBATEK).
     */
    #openBus() {
        const cpu = this.cpu;
        if (!cpu) return 0;
        const next = cpu.r[15] >>> 0;
        if (!cpu.thumb) return this.#peek16(next & ~3) | (this.#peek16((next & ~3) + 2) << 16);
        const value = this.#peek16(next);
        switch ((next >>> 24) & 0xf) {
            case Region.BIOS:
            case Region.OAM:
                return next & 2 ? this.#peek16(next - 2) | (value << 16) : value | (this.#peek16(next + 2) << 16);
            case Region.IWRAM:
                return next & 2 ? this.#peek16(next - 2) | (value << 16) : value | (this.#peek16(next - 2) << 16);
            default:
                return value | (value << 16);
        }
    }

    /** Reads code memory without side effects. */
    #peek16(address) {
        const region = (address >>> 24) & 0xf;
        if (region === Region.IO || region >= Region.SRAM || (region === Region.ROM2_HI && this.backup.eeprom)) return 0;
        if (region === Region.BIOS && address >= 0x4000) return 0;
        return this.#read16(address & ~1);
    }

    write8(address, value) {
        this.writes++;
        const region = (address >>> 24) & 0xf;
        this.#access(address, region, this.n16[region], 0, false);
        value &= 0xff;
        switch (region) {
            case Region.EWRAM: this.ewram[address & 0x3ffff] = value; break;
            case Region.IWRAM: this.iwram[address & 0x7fff] = value; break;
            case Region.IO:
                if ((address & 0xffffff) < 0x400) this.io.write8(address & 0x3ff, value);
                else this.#writeDebug(address, value);
                break;
            case Region.PALETTE:
                // 8-bit writes to video memory store the byte in both halves.
                this.ppu.palette16[(address & 0x3ff) >> 1] = value * 0x0101;
                break;
            case Region.VRAM: {
                const index = vramIndex(address);
                // ...except sprite tiles, where they are ignored.
                if (index < (this.ppu.bitmapMode ? 0x14000 : 0x10000)) this.ppu.vram16[index >> 1] = value * 0x0101;
                break;
            }
            case Region.OAM: break;
            case Region.SRAM:
            case Region.SRAM_HI:
                this.backup.write8(address & 0xffff, value);
                break;
            default:
                if (region >= Region.ROM0) this.#writeRom(address, value);
        }
    }

    write16(address, value, sequential = false) {
        this.writes++;
        const region = (address >>> 24) & 0xf;
        this.#access(address, region, this.n16[region], this.s16[region], sequential);
        // SRAM gets the byte of the value that lines up with the address.
        if (region >= Region.SRAM) this.backup.write8(address & 0xffff, (value >>> ((address & 1) * 8)) & 0xff);
        else this.#write16(address & ~1, value & 0xffff);
    }

    write32(address, value, sequential = false) {
        this.writes++;
        const region = (address >>> 24) & 0xf;
        this.#access(address, region, this.n32[region], this.s32[region], sequential);
        if (region >= Region.SRAM) {
            this.backup.write8(address & 0xffff, (value >>> ((address & 3) * 8)) & 0xff);
            return;
        }
        address &= ~3;
        switch (region) {
            case Region.EWRAM: this.ewram32[(address & 0x3ffff) >> 2] = value; return;
            case Region.IWRAM: this.iwram32[(address & 0x7fff) >> 2] = value; return;
            case Region.PALETTE: this.ppu.palette32[(address & 0x3ff) >> 2] = value; return;
            case Region.VRAM: this.ppu.vram32[vramIndex(address) >> 2] = value; return;
            case Region.OAM: this.ppu.oam32[(address & 0x3ff) >> 2] = value; return;
            case Region.SRAM:
            case Region.SRAM_HI:
                this.backup.write8(address & 0xffff, value >>> ((address & 3) * 8));
                return;
            default:
                this.#write16(address, value & 0xffff);
                this.#write16(address + 2, (value >>> 16) & 0xffff);
        }
    }

    #write16(address, value) {
        switch ((address >>> 24) & 0xf) {
            case Region.EWRAM: this.ewram16[(address & 0x3ffff) >> 1] = value; break;
            case Region.IWRAM: this.iwram16[(address & 0x7fff) >> 1] = value; break;
            case Region.IO:
                if ((address & 0xffffff) < 0x400) this.io.write16(address & 0x3fe, value);
                else {
                    this.#writeDebug(address, value & 0xff);
                    this.#writeDebug(address + 1, value >>> 8);
                }
                break;
            case Region.PALETTE: this.ppu.palette16[(address & 0x3ff) >> 1] = value; break;
            case Region.VRAM: this.ppu.vram16[vramIndex(address) >> 1] = value; break;
            case Region.OAM: this.ppu.oam16[(address & 0x3ff) >> 1] = value; break;
            case Region.SRAM:
            case Region.SRAM_HI:
                this.backup.write8(address & 0xffff, value >>> ((address & 1) * 8));
                break;
            default:
                if (((address >>> 24) & 0xf) >= Region.ROM0) this.#writeRom(address, value);
        }
    }

    /** Writes to the cartridge: the EEPROM and the GPIO port (real-time clock). */
    #writeRom(address, value) {
        const region = (address >>> 24) & 0xf;
        if (region === Region.ROM2_HI && this.backup.eeprom && this.backup.isEeprom(address, this.romSize)) {
            this.backup.writeEeprom(value);
            return;
        }
        const offset = address & 0x1ffffff;
        if (this.gpio && offset >= 0xc4 && offset < 0xca) this.gpio.write(offset & ~1, value);
    }

    // --- DMA ------------------------------------------------------------------------

    /** DMA reads and writes: no cycles counted here (the DMA unit counts them). */
    dmaRead16(address) {
        return this.#read16(address & ~1);
    }

    dmaRead32(address) {
        return this.#read32(address & ~3);
    }

    dmaWrite16(address, value) {
        this.writes++;
        this.#write16(address & ~1, value & 0xffff);
    }

    dmaWrite32(address, value) {
        this.writes++;
        address &= ~3;
        this.#write16(address, value & 0xffff);
        this.#write16(address + 2, (value >>> 16) & 0xffff);
    }
}

/** VRAM is 96 KB, mirrored in 128 KB blocks (the last 32 KB repeat the sprite area). */
export function vramIndex(address) {
    const index = address & 0x1ffff;
    return index >= 0x18000 ? index - 0x8000 : index;
}
