// Flag bits in F.
const Z = 0x80;
const N = 0x40;
const H = 0x20;
const C = 0x10;

// How a CPU write to an I/O register lines up with the PPU and timers reading
// it in the same M-cycle (SameBoy's access conflicts, MIT).
const Conflict = {
    READ_OLD: 0, // the write lands at the end of the M-cycle
    READ_NEW: 1, // 1 T-cycle earlier
    WRITE_CPU: 2, // 1 T-cycle later
    STAT_DMG: 3, // the DMG STAT bug: all sources enabled for a T-cycle
    STAT_CGB: 4,
    STAT_CGB_DOUBLE: 5,
    PALETTE_DMG: 6, // old | new for a T-cycle
    PALETTE_CGB: 7,
    LCDC_DMG: 8,
    LCDC_SGB: 9,
    LCDC_CGB: 10,
    LCDC_CGB_DOUBLE: 11,
    WX_DMG: 12,
    SCX: 13, // 2 T-cycles earlier (SCX and the DMG's SCY, CGB double speed)
};

function conflictMap(entries) {
    const map = new Uint8Array(0x80);
    for (const [register, conflict] of entries) map[register - 0xff00] = conflict;
    return map;
}

const IF = 0xff0f;
const NR10 = 0xff10;
const LCDC = 0xff40;
const STAT = 0xff41;
const SCY = 0xff42;
const SCX = 0xff43;
const LYC = 0xff45;
const BGP = 0xff47;
const OBP0 = 0xff48;
const OBP1 = 0xff49;
const WY = 0xff4a;
const WX = 0xff4b;

const CGB_CONFLICTS = conflictMap([
    [LCDC, Conflict.LCDC_CGB], [IF, Conflict.WRITE_CPU], [LYC, Conflict.WRITE_CPU], [WY, Conflict.READ_OLD],
    [STAT, Conflict.STAT_CGB], [BGP, Conflict.PALETTE_CGB], [OBP0, Conflict.PALETTE_CGB],
    [OBP1, Conflict.PALETTE_CGB], [SCX, Conflict.READ_OLD], [WX, Conflict.WRITE_CPU],
]);
const CGB_DOUBLE_CONFLICTS = conflictMap([
    [LCDC, Conflict.LCDC_CGB_DOUBLE], [IF, Conflict.WRITE_CPU], [LYC, Conflict.READ_OLD], [WY, Conflict.READ_OLD],
    [STAT, Conflict.STAT_CGB_DOUBLE], [NR10, Conflict.READ_OLD], [SCX, Conflict.SCX], [WX, Conflict.READ_OLD],
]);
// IF is written on time on a DMG (gbmicrotest's lyc1_int_if_edge; SameBoy writes it a T-cycle late).
const DMG_CONFLICTS = conflictMap([
    [IF, Conflict.READ_OLD], [LYC, Conflict.READ_OLD], [LCDC, Conflict.LCDC_DMG], [SCY, Conflict.SCX],
    [STAT, Conflict.STAT_DMG], [BGP, Conflict.PALETTE_DMG], [OBP0, Conflict.PALETTE_DMG],
    [OBP1, Conflict.PALETTE_DMG], [WY, Conflict.READ_OLD], [WX, Conflict.WX_DMG], [SCX, Conflict.SCX],
]);
const SGB_CONFLICTS = conflictMap([
    [IF, Conflict.WRITE_CPU], [LYC, Conflict.READ_OLD], [LCDC, Conflict.LCDC_SGB], [SCY, Conflict.READ_NEW],
    [STAT, Conflict.STAT_DMG], [BGP, Conflict.READ_NEW], [OBP0, Conflict.READ_NEW], [OBP1, Conflict.READ_NEW],
    [WY, Conflict.READ_OLD], [WX, Conflict.WX_DMG], [SCX, Conflict.SCX],
]);

/**
 * Sharp SM83, the Game Boy CPU, timed to the T-cycle (after SameBoy's
 * sm83_cpu.c, MIT).
 *
 * Time is owed rather than spent: each access leaves `pending` T-cycles
 * (normally the 4 of its M-cycle) that the next access first passes on to
 * `gb.advance()`. Reads happen at the start of their M-cycle; writes to most
 * I/O registers land a T-cycle or two earlier or later (see Conflict), which
 * decides who sees what when the CPU and the PPU touch a register in the same
 * M-cycle.
 *
 * Registers r8 are indexed as in the opcode encoding:
 * 0 B, 1 C, 2 D, 3 E, 4 H, 5 L, 6 (HL), 7 A.
 */
export class Cpu {
    /** @param {import("./gameboy.js").GameBoy} gb */
    constructor(gb) {
        this.gb = gb;
        this.reset();
    }

    reset() {
        this.a = 0;
        this.f = 0;
        this.b = 0;
        this.c = 0;
        this.d = 0;
        this.e = 0;
        this.h = 0;
        this.l = 0;
        this.sp = 0;
        this.pc = 0;
        this.ime = false;
        // EI: IME flips at the start of the next instruction.
        this.imeToggle = false;
        this.halted = false;
        this.justHalted = false;
        // HALT with IME=0 and an interrupt pending doesn't halt; instead the next
        // opcode byte is read twice.
        this.haltBug = false;
        this.stopped = false;
        // T-cycles owed to the rest of the system (see the class comment).
        this.pending = 0;
    }

    sync(s) {
        for (const r of ["a", "f", "b", "c", "d", "e", "h", "l"]) this[r] = s.u8(this[r]);
        this.sp = s.u16(this.sp);
        this.pc = s.u16(this.pc);
        for (const flag of ["ime", "imeToggle", "halted", "justHalted", "haltBug", "stopped"]) this[flag] = s.bool(this[flag]);
        this.pending = s.u8(this.pending);
    }

    /** Runs one instruction, interrupt dispatch or idle step (GB_cpu_run). */
    step() {
        const gb = this.gb;
        const io = gb.io;
        if (this.stopped) {
            gb.advance(4);
            if ((gb.joypad.read() & 0x0f) !== 0x0f) {
                gb.leaveStopMode();
                gb.advance(8);
            }
            return;
        }
        if (this.halted && !this.justHalted && !(gb.ie & io[0x0f] & 0x1f)) {
            // Nothing can wake the CPU before the next event: skip ahead.
            const idle = gb.idleCycles();
            if (idle) {
                gb.advance(idle);
                return;
            }
        }
        // While halted, the DMG samples interrupts halfway through an M-cycle.
        if (this.halted && !gb.cgb && !this.justHalted) gb.advance(2);
        const queue = gb.ie & io[0x0f] & 0x1f;
        if (this.halted) gb.advance(gb.cgb || this.justHalted ? 4 : 2);
        this.justHalted = false;

        const effectiveIme = this.ime;
        if (this.imeToggle) {
            this.ime = !this.ime;
            this.imeToggle = false;
        }

        if (this.halted && !effectiveIme && queue) {
            // Wakes up without calling the interrupt.
            this.halted = false;
            gb.wake();
        } else if (effectiveIme && queue) {
            this.halted = false;
            gb.wake();
            this.#interrupt();
        } else if (!this.halted) {
            const opcode = this.#read(this.pc);
            this.pc = (this.pc + 1) & 0xffff;
            if (gb.hdmaOn) gb.hdmaRun();
            if (this.haltBug) {
                this.pc = (this.pc - 1) & 0xffff;
                this.haltBug = false;
            }
            this.#execute(opcode);
        }
        this.#flush();
    }

    #interrupt() {
        const gb = this.gb;
        const io = gb.io;
        this.#read(this.pc);
        this.#oamBugCycle((this.pc + 1) & 0xffff);
        gb.triggerOamBug(this.sp);
        this.#noAccess();
        this.sp = (this.sp - 1) & 0xffff;
        this.#write(this.sp, this.pc >> 8);
        // Pushing the high byte can overwrite IE (SP = 0x0000), and the low
        // byte IF (SP = 0xFF10), which changes or cancels the interrupt.
        let queue = gb.ie;
        this.sp = (this.sp - 1) & 0xffff;
        if (this.sp === IF) {
            queue &= this.#writeIf(this.pc & 0xff);
        } else {
            this.#write(this.sp, this.pc & 0xff);
            queue &= io[0x0f] & 0x1f;
        }
        if (queue) {
            const bit = 31 - Math.clz32(queue & -queue);
            // IF is acknowledged 2 T-cycles before the end of the M-cycle.
            this.pending -= 2;
            this.#flush();
            this.pending = 2;
            io[0x0f] &= ~(1 << bit);
            this.pc = 0x40 + bit * 8;
        } else {
            this.pc = 0;
        }
        this.ime = false;
    }

    // --- Bus cycles ------------------------------------------------------------

    #read(addr) {
        const gb = this.gb;
        if (this.pending) gb.advance(this.pending);
        gb.addressBus = addr;
        const value = gb.read(addr);
        this.pending = 4;
        return value;
    }

    /** Pushing PC's low byte onto IF during interrupt dispatch: returns IF before the write. */
    #writeIf(value) {
        const gb = this.gb;
        gb.advance(this.pending);
        gb.addressBus = IF;
        const old = gb.io[0x0f] & 0x1f;
        gb.write(IF, value);
        this.pending = 4;
        return old;
    }

    #write(addr, value) {
        const gb = this.gb;
        let pending = this.pending;
        if ((addr & 0xff80) !== 0xff00) {
            gb.advance(pending);
            gb.write(addr, value);
            this.pending = 4;
            gb.addressBus = addr;
            return;
        }
        const map = gb.cgb ? (gb.doubleSpeed ? CGB_DOUBLE_CONFLICTS : CGB_CONFLICTS) : gb.sgb ? SGB_CONFLICTS : DMG_CONFLICTS;
        const io = gb.io;
        const ppu = gb.ppu;
        switch (map[addr & 0x7f]) {
            case Conflict.READ_OLD:
                gb.advance(pending);
                gb.write(addr, value);
                pending = 4;
                break;
            case Conflict.READ_NEW:
                gb.advance(pending - 1);
                gb.write(addr, value);
                pending = 5;
                break;
            case Conflict.WRITE_CPU:
                gb.advance(pending + 1);
                gb.write(addr, value);
                pending = 3;
                break;
            case Conflict.STAT_DMG:
                // The STAT bug: STAT reads as if every source were enabled for a
                // T-cycle. At the HBlank-to-OAM edge, HBlank blocks the OAM source.
                gb.advance(pending);
                ppu.catchUp();
                gb.write(addr, ppu.state === 7 && (io[0x41] & 0x28) === 0x08 ? 0xdf : 0xff);
                gb.advance(1);
                gb.write(addr, value);
                pending = 3;
                break;
            case Conflict.STAT_CGB: {
                // The LYC bit takes effect a T-cycle later.
                const old = io[0x41];
                gb.advance(pending);
                gb.write(addr, (old & 0x40) | (value & ~0x40));
                gb.advance(1);
                gb.write(addr, value);
                pending = 3;
                break;
            }
            case Conflict.STAT_CGB_DOUBLE: {
                const old = io[0x41];
                gb.advance(pending);
                gb.write(addr, (value & ~8) | (old & 8));
                gb.advance(1);
                gb.write(addr, value);
                pending = 3;
                break;
            }
            case Conflict.PALETTE_DMG: {
                gb.advance(pending - 2);
                const old = gb.read(addr);
                gb.write(addr, value | old);
                gb.advance(1);
                gb.write(addr, value);
                pending = 5;
                break;
            }
            case Conflict.PALETTE_CGB:
                gb.advance(pending - 2);
                gb.write(addr, value);
                pending = 6;
                break;
            case Conflict.LCDC_DMG: {
                // LCDC.1 is read both when pixels are popped and by the object
                // fetcher, which see the write differently. The tile map, tile
                // data and sprite size bits reach the fetcher a T-cycle before
                // the others (Mealybug Tearoom; SameBoy delays them too).
                let old = gb.read(addr);
                gb.advance(pending - 2);
                ppu.catchUp();
                if (ppu.positionInLine === 0 && !(value & 2)) old &= ~2;
                else if (ppu.duringObjectFetch && !(value & 2)) old &= ~2;
                gb.write(addr, (value & ~0xa3) | (old & 0xa2) | ((old | value) & 1));
                gb.advance(1);
                gb.write(addr, value);
                if (old & 0x20 && !(value & 0x20) && ppu.windowIsBeingFetched) {
                    ppu.disableWindowPixelInsertionGlitch = true;
                }
                pending = 5;
                break;
            }
            case Conflict.LCDC_SGB: {
                const old = gb.read(addr);
                gb.advance(pending - 2);
                // Writing the new value and back aborts an object fetch.
                gb.write(addr, value);
                gb.write(addr, old);
                gb.advance(1);
                gb.write(addr, value);
                pending = 5;
                break;
            }
            case Conflict.WX_DMG:
                gb.advance(pending);
                gb.write(addr, value);
                ppu.wxJustChanged = true;
                gb.advance(1);
                ppu.wxJustChanged = false;
                pending = 3;
                break;
            case Conflict.LCDC_CGB: {
                const old = io[0x40];
                gb.advance(pending);
                gb.write(addr, value);
                if (~value & old & 0x10) {
                    ppu.tileSelGlitch = true;
                    gb.advance(1);
                    ppu.tileSelGlitch = false;
                    pending = 3;
                } else {
                    pending = 4;
                }
                break;
            }
            case Conflict.LCDC_CGB_DOUBLE: {
                const old = io[0x40];
                gb.advance(pending - 2);
                gb.write(addr, (value & ~0x81) | (old & 0x81));
                ppu.tileSelGlitch = ((value ^ old) & 0x10) !== 0;
                gb.advance(2);
                ppu.tileSelGlitch = false;
                gb.write(addr, value);
                pending = 4;
                break;
            }
            case Conflict.SCX:
                gb.advance(pending - 2);
                gb.write(addr, value);
                pending = 6;
                break;
        }
        this.pending = pending;
        gb.addressBus = addr;
    }

    #noAccess() {
        this.pending += 4;
    }

    /**
     * An M-cycle where the 16-bit increment/decrement unit drives the address
     * bus: with a value in FE00-FEFF it disturbs OAM on a DMG.
     */
    #oamBugCycle(value) {
        const gb = this.gb;
        if (this.pending) gb.advance(this.pending);
        gb.addressBus = value;
        gb.triggerOamBug(value);
        this.pending = 4;
    }

    #flush() {
        if (this.pending) this.gb.advance(this.pending);
        this.pending = 0;
    }

    #fetch() {
        const value = this.#read(this.pc);
        this.pc = (this.pc + 1) & 0xffff;
        return value;
    }

    #fetch16() {
        const low = this.#fetch();
        return low | (this.#fetch() << 8);
    }

    #push(value) {
        this.#oamBugCycle(this.sp);
        this.sp = (this.sp - 1) & 0xffff;
        this.#write(this.sp, value >> 8);
        this.sp = (this.sp - 1) & 0xffff;
        this.#write(this.sp, value & 0xff);
    }

    #pop() {
        const low = this.#read(this.sp);
        this.sp = (this.sp + 1) & 0xffff;
        const high = this.#read(this.sp);
        this.sp = (this.sp + 1) & 0xffff;
        return low | (high << 8);
    }

    // --- Registers -------------------------------------------------------------

    get bc() {
        return (this.b << 8) | this.c;
    }
    set bc(v) {
        this.b = v >> 8;
        this.c = v & 0xff;
    }
    get de() {
        return (this.d << 8) | this.e;
    }
    set de(v) {
        this.d = v >> 8;
        this.e = v & 0xff;
    }
    get hl() {
        return (this.h << 8) | this.l;
    }
    set hl(v) {
        this.h = v >> 8;
        this.l = v & 0xff;
    }

    #getR(i) {
        switch (i) {
            case 0: return this.b;
            case 1: return this.c;
            case 2: return this.d;
            case 3: return this.e;
            case 4: return this.h;
            case 5: return this.l;
            case 6: return this.#read(this.hl);
            default: return this.a;
        }
    }

    #setR(i, v) {
        switch (i) {
            case 0: this.b = v; break;
            case 1: this.c = v; break;
            case 2: this.d = v; break;
            case 3: this.e = v; break;
            case 4: this.h = v; break;
            case 5: this.l = v; break;
            case 6: this.#write(this.hl, v); break;
            default: this.a = v;
        }
    }

    /** Register pair for 16-bit loads and arithmetic: 0 BC, 1 DE, 2 HL, 3 SP. */
    #getRp(i) {
        switch (i) {
            case 0: return this.bc;
            case 1: return this.de;
            case 2: return this.hl;
            default: return this.sp;
        }
    }

    #setRp(i, v) {
        switch (i) {
            case 0: this.bc = v; break;
            case 1: this.de = v; break;
            case 2: this.hl = v; break;
            default: this.sp = v;
        }
    }

    /** Condition codes: 0 NZ, 1 Z, 2 NC, 3 C. */
    #cond(i) {
        switch (i) {
            case 0: return !(this.f & Z);
            case 1: return (this.f & Z) !== 0;
            case 2: return !(this.f & C);
            default: return (this.f & C) !== 0;
        }
    }

    // --- ALU -------------------------------------------------------------------

    #alu(op, v) {
        const a = this.a;
        let r;
        switch (op) {
            case 0: // ADD
                r = a + v;
                this.f = (r & 0xff ? 0 : Z) | ((a & 0xf) + (v & 0xf) > 0xf ? H : 0) | (r > 0xff ? C : 0);
                this.a = r & 0xff;
                break;
            case 1: { // ADC
                const carry = this.f & C ? 1 : 0;
                r = a + v + carry;
                this.f = (r & 0xff ? 0 : Z) | ((a & 0xf) + (v & 0xf) + carry > 0xf ? H : 0) | (r > 0xff ? C : 0);
                this.a = r & 0xff;
                break;
            }
            case 2: // SUB
                r = a - v;
                this.f = (r & 0xff ? 0 : Z) | N | ((a & 0xf) < (v & 0xf) ? H : 0) | (r < 0 ? C : 0);
                this.a = r & 0xff;
                break;
            case 3: { // SBC
                const carry = this.f & C ? 1 : 0;
                r = a - v - carry;
                this.f = (r & 0xff ? 0 : Z) | N | ((a & 0xf) - (v & 0xf) - carry < 0 ? H : 0) | (r < 0 ? C : 0);
                this.a = r & 0xff;
                break;
            }
            case 4: // AND
                this.a = a & v;
                this.f = (this.a ? 0 : Z) | H;
                break;
            case 5: // XOR
                this.a = a ^ v;
                this.f = this.a ? 0 : Z;
                break;
            case 6: // OR
                this.a = a | v;
                this.f = this.a ? 0 : Z;
                break;
            default: // CP
                r = a - v;
                this.f = (r & 0xff ? 0 : Z) | N | ((a & 0xf) < (v & 0xf) ? H : 0) | (r < 0 ? C : 0);
        }
    }

    #inc(v) {
        const r = (v + 1) & 0xff;
        this.f = (this.f & C) | (r ? 0 : Z) | ((v & 0xf) === 0xf ? H : 0);
        return r;
    }

    #dec(v) {
        const r = (v - 1) & 0xff;
        this.f = (this.f & C) | (r ? 0 : Z) | N | ((v & 0xf) === 0 ? H : 0);
        return r;
    }

    #addHl(v) {
        this.#noAccess();
        const hl = this.hl;
        const r = hl + v;
        this.f = (this.f & Z) | ((hl & 0xfff) + (v & 0xfff) > 0xfff ? H : 0) | (r > 0xffff ? C : 0);
        this.hl = r & 0xffff;
    }

    /** SP + signed 8-bit offset; flags come from the unsigned low-byte addition. */
    #spOffset(e) {
        const sp = this.sp;
        this.f = ((sp & 0xf) + (e & 0xf) > 0xf ? H : 0) | ((sp & 0xff) + e > 0xff ? C : 0);
        return (sp + ((e << 24) >> 24)) & 0xffff;
    }

    #daa() {
        let a = this.a;
        let f = this.f;
        if (!(f & N)) {
            if (f & C || a > 0x99) {
                a += 0x60;
                f |= C;
            }
            if (f & H || (a & 0x0f) > 0x09) a += 0x06;
        } else {
            if (f & C) a -= 0x60;
            if (f & H) a -= 0x06;
        }
        a &= 0xff;
        this.a = a;
        this.f = (f & (N | C)) | (a ? 0 : Z);
    }

    /** Rotates and shifts of the CB page: RLC RRC RL RR SLA SRA SWAP SRL. */
    #shift(op, v) {
        let r;
        let carry;
        switch (op) {
            case 0: carry = v >> 7; r = (v << 1) | carry; break;
            case 1: carry = v & 1; r = (v >> 1) | (carry << 7); break;
            case 2: carry = v >> 7; r = (v << 1) | (this.f & C ? 1 : 0); break;
            case 3: carry = v & 1; r = (v >> 1) | (this.f & C ? 0x80 : 0); break;
            case 4: carry = v >> 7; r = v << 1; break;
            case 5: carry = v & 1; r = (v >> 1) | (v & 0x80); break;
            case 6: carry = 0; r = ((v << 4) | (v >> 4)); break;
            default: carry = v & 1; r = v >> 1;
        }
        r &= 0xff;
        this.f = (r ? 0 : Z) | (carry ? C : 0);
        return r;
    }

    #prefixCb() {
        const op = this.#fetch();
        const reg = op & 7;
        const bit = (op >> 3) & 7;
        const v = this.#getR(reg);
        switch (op >> 6) {
            case 0:
                this.#setR(reg, this.#shift(bit, v));
                break;
            case 1: // BIT
                this.f = (this.f & C) | H | (v & (1 << bit) ? 0 : Z);
                break;
            case 2: // RES
                this.#setR(reg, v & ~(1 << bit));
                break;
            default: // SET
                this.#setR(reg, v | (1 << bit));
        }
    }

    // --- Control flow ------------------------------------------------------------

    #call(taken) {
        const addr = this.#fetch16();
        if (taken) {
            this.#push(this.pc);
            this.pc = addr;
        }
    }

    #ret() {
        this.pc = this.#pop();
        this.#noAccess();
    }

    #halt() {
        const gb = this.gb;
        this.#read(this.pc);
        // The rest of this M-cycle passes while halted (see step()).
        this.pending = 0;
        if (gb.ie & gb.io[0x0f] & 0x1f) {
            // An interrupt is already pending. With IME set (EI; HALT) it is
            // taken right away and returns to the HALT; with IME off, the HALT
            // bug: the next byte is read twice.
            if (this.ime) this.pc = (this.pc - 1) & 0xffff;
            else this.haltBug = true;
        } else {
            this.halted = true;
            gb.allowHdmaOnWake = (gb.io[0x41] & 3) !== 0;
        }
        this.justHalted = true;
    }

    // --- Decoder -------------------------------------------------------------------

    #execute(op) {
        switch (op) {
            case 0x00: break; // NOP
            case 0x01: case 0x11: case 0x21: case 0x31: // LD rr,d16
                this.#setRp(op >> 4, this.#fetch16());
                break;
            case 0x02: this.#write(this.bc, this.a); break; // LD (BC),A
            case 0x12: this.#write(this.de, this.a); break; // LD (DE),A
            case 0x22: { // LD (HL+),A
                const hl = this.hl;
                this.hl = (hl + 1) & 0xffff;
                this.#write(hl, this.a);
                break;
            }
            case 0x32: { // LD (HL-),A
                const hl = this.hl;
                this.hl = (hl - 1) & 0xffff;
                this.#write(hl, this.a);
                break;
            }
            case 0x03: case 0x13: case 0x23: case 0x33: { // INC rr
                const value = this.#getRp(op >> 4);
                this.#oamBugCycle(value);
                this.#setRp(op >> 4, (value + 1) & 0xffff);
                break;
            }
            case 0x0b: case 0x1b: case 0x2b: case 0x3b: { // DEC rr
                const value = this.#getRp(op >> 4);
                this.#oamBugCycle(value);
                this.#setRp(op >> 4, (value - 1) & 0xffff);
                break;
            }
            case 0x04: case 0x0c: case 0x14: case 0x1c: case 0x24: case 0x2c: case 0x34: case 0x3c: // INC r
                this.#setR(op >> 3, this.#inc(this.#getR(op >> 3)));
                break;
            case 0x05: case 0x0d: case 0x15: case 0x1d: case 0x25: case 0x2d: case 0x35: case 0x3d: // DEC r
                this.#setR(op >> 3, this.#dec(this.#getR(op >> 3)));
                break;
            case 0x06: case 0x0e: case 0x16: case 0x1e: case 0x26: case 0x2e: case 0x36: case 0x3e: // LD r,d8
                this.#setR(op >> 3, this.#fetch());
                break;
            case 0x07: { // RLCA
                const carry = this.a >> 7;
                this.a = ((this.a << 1) | carry) & 0xff;
                this.f = carry ? C : 0;
                break;
            }
            case 0x0f: { // RRCA
                const carry = this.a & 1;
                this.a = (this.a >> 1) | (carry << 7);
                this.f = carry ? C : 0;
                break;
            }
            case 0x17: { // RLA
                const carry = this.a >> 7;
                this.a = ((this.a << 1) | (this.f & C ? 1 : 0)) & 0xff;
                this.f = carry ? C : 0;
                break;
            }
            case 0x1f: { // RRA
                const carry = this.a & 1;
                this.a = (this.a >> 1) | (this.f & C ? 0x80 : 0);
                this.f = carry ? C : 0;
                break;
            }
            case 0x08: { // LD (a16),SP
                const addr = this.#fetch16();
                this.#write(addr, this.sp & 0xff);
                this.#write((addr + 1) & 0xffff, this.sp >> 8);
                break;
            }
            case 0x09: case 0x19: case 0x29: case 0x39: // ADD HL,rr
                this.#addHl(this.#getRp(op >> 4));
                break;
            case 0x0a: this.a = this.#read(this.bc); break; // LD A,(BC)
            case 0x1a: this.a = this.#read(this.de); break; // LD A,(DE)
            case 0x2a: { // LD A,(HL+)
                const hl = this.hl;
                this.hl = (hl + 1) & 0xffff;
                this.a = this.#read(hl);
                break;
            }
            case 0x3a: { // LD A,(HL-)
                const hl = this.hl;
                this.hl = (hl - 1) & 0xffff;
                this.a = this.#read(hl);
                break;
            }
            case 0x10: this.#stop(); break;
            case 0x18: { // JR
                const e = this.#fetch();
                this.#oamBugCycle(this.pc);
                this.pc = (this.pc + ((e << 24) >> 24)) & 0xffff;
                break;
            }
            case 0x20: case 0x28: case 0x30: case 0x38: { // JR cc
                const e = this.#fetch();
                if (this.#cond((op >> 3) & 3)) {
                    this.pc = (this.pc + ((e << 24) >> 24)) & 0xffff;
                    this.#oamBugCycle(this.pc);
                }
                break;
            }
            case 0x27: this.#daa(); break;
            case 0x2f: // CPL
                this.a ^= 0xff;
                this.f |= N | H;
                break;
            case 0x37: // SCF
                this.f = (this.f & Z) | C;
                break;
            case 0x3f: // CCF
                this.f = (this.f & (Z | C)) ^ C;
                break;
            case 0x76: this.#halt(); break;

            case 0xc0: case 0xc8: case 0xd0: case 0xd8: // RET cc
                this.#noAccess();
                if (this.#cond((op >> 3) & 3)) this.#ret();
                break;
            case 0xc9: this.#ret(); break;
            case 0xd9: // RETI
                this.#ret();
                this.ime = true;
                break;
            case 0xc1: case 0xd1: case 0xe1: // POP rr
                this.#setRp((op >> 4) & 3, this.#pop());
                break;
            case 0xf1: { // POP AF
                const v = this.#pop();
                this.a = v >> 8;
                this.f = v & 0xf0;
                break;
            }
            case 0xc5: case 0xd5: case 0xe5: // PUSH rr
                this.#push(this.#getRp((op >> 4) & 3));
                break;
            case 0xf5: this.#push((this.a << 8) | this.f); break; // PUSH AF
            case 0xc2: case 0xca: case 0xd2: case 0xda: { // JP cc
                const addr = this.#fetch16();
                if (this.#cond((op >> 3) & 3)) {
                    this.#noAccess();
                    this.pc = addr;
                }
                break;
            }
            case 0xc3: { // JP
                const addr = this.#fetch16();
                this.#noAccess();
                this.pc = addr;
                break;
            }
            case 0xe9: this.pc = this.hl; break; // JP HL
            case 0xc4: case 0xcc: case 0xd4: case 0xdc: // CALL cc
                this.#call(this.#cond((op >> 3) & 3));
                break;
            case 0xcd: this.#call(true); break;
            case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff: // RST
                this.#push(this.pc);
                this.pc = op & 0x38;
                break;
            case 0xc6: case 0xce: case 0xd6: case 0xde: case 0xe6: case 0xee: case 0xf6: case 0xfe: // ALU A,d8
                this.#alu((op >> 3) & 7, this.#fetch());
                break;
            case 0xcb: this.#prefixCb(); break;

            case 0xe0: this.#write(0xff00 | this.#fetch(), this.a); break; // LDH (a8),A
            case 0xf0: this.a = this.#read(0xff00 | this.#fetch()); break; // LDH A,(a8)
            case 0xe2: this.#write(0xff00 | this.c, this.a); break; // LD (C),A
            case 0xf2: this.a = this.#read(0xff00 | this.c); break; // LD A,(C)
            case 0xea: this.#write(this.#fetch16(), this.a); break; // LD (a16),A
            case 0xfa: this.a = this.#read(this.#fetch16()); break; // LD A,(a16)
            case 0xe8: { // ADD SP,e8
                const sp = this.#spOffset(this.#fetch());
                this.#noAccess();
                this.#noAccess();
                this.sp = sp;
                break;
            }
            case 0xf8: { // LD HL,SP+e8
                const v = this.#spOffset(this.#fetch());
                this.#noAccess();
                this.hl = v;
                break;
            }
            case 0xf9: // LD SP,HL
                this.sp = this.hl;
                this.#oamBugCycle(this.hl);
                break;
            case 0xf3: // DI (not delayed)
                this.ime = false;
                break;
            case 0xfb: // EI
                if (!this.ime) this.imeToggle = true;
                break;

            case 0xd3: case 0xdb: case 0xdd: case 0xe3: case 0xe4: case 0xeb: case 0xec: case 0xed: case 0xf4: case 0xfc: case 0xfd:
                // Illegal opcodes lock the CPU up until reset.
                this.gb.ie = 0;
                this.halted = true;
                break;

            default:
                if (op < 0x80) {
                    this.#setR((op >> 3) & 7, this.#getR(op & 7)); // LD r,r'
                } else {
                    this.#alu((op >> 3) & 7, this.#getR(op & 7)); // ALU A,r
                }
        }
    }

    /** STOP: stops the CPU (and the DMG's PPU) until a button is pressed, or switches the CGB's speed. */
    #stop() {
        const gb = this.gb;
        const io = gb.io;
        this.#flush();
        const exitByJoypad = (gb.joypad.read() & 0x0f) !== 0x0f;
        const speedSwitch = gb.cgb && (io[0x4d] & 1) !== 0 && !exitByJoypad;
        const immediateExit = speedSwitch || exitByJoypad;
        const interruptPending = (gb.ie & io[0x0f] & 0x1f) !== 0;
        if (!exitByJoypad) {
            if (!immediateExit) gb.dmaRun();
            gb.enterStopMode();
        }
        // With an interrupt pending, the second byte of STOP is executed as an opcode.
        if (!interruptPending) this.#fetch();
        if (speedSwitch) {
            this.#flush();
            gb.switchSpeed(interruptPending);
        }
        if (immediateExit) {
            gb.leaveStopMode();
            if (!interruptPending) {
                gb.dmaRun();
                this.halted = true;
                this.justHalted = true;
                gb.allowHdmaOnWake = (io[0x41] & 3) !== 0;
            } else {
                gb.speedSwitchHaltCountdown = 0;
            }
        }
    }
}
