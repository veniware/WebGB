// Flag bits in F.
const Z = 0x80;
const N = 0x40;
const H = 0x20;
const C = 0x10;

/**
 * Sharp SM83, the Game Boy CPU.
 *
 * Every memory access and internal delay calls `gb.tick()`, which advances
 * the rest of the system by one M-cycle before the access happens. Other
 * components therefore see reads and writes at the right cycle within an
 * instruction, which timing-sensitive games and test ROMs depend on.
 *
 * Registers r8 are indexed as in the opcode encoding:
 * 0 B, 1 C, 2 D, 3 E, 4 H, 5 L, 6 (HL), 7 A.
 */
export class Cpu {
    /** @param {import('./gameboy.js').GameBoy} gb */
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
        // EI takes effect after the following instruction.
        this.imePending = false;
        this.halted = false;
        // HALT with IME=0 and an interrupt pending doesn't halt; instead the next
        // opcode byte is read twice.
        this.haltBug = false;
        this.stopped = false;
        // An illegal opcode locks the CPU up until reset.
        this.locked = false;
        // M-cycles the CPU is held for (HDMA, speed switch).
        this.stall = 0;
        this.ifAtFetch = 0;
    }

    sync(s) {
        for (const r of ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l']) this[r] = s.u8(this[r]);
        this.sp = s.u16(this.sp);
        this.pc = s.u16(this.pc);
        for (const flag of ['ime', 'imePending', 'halted', 'haltBug', 'stopped', 'locked']) this[flag] = s.bool(this[flag]);
        this.stall = s.u32(this.stall);
    }

    /** Runs one instruction, interrupt dispatch or idle M-cycle. */
    step() {
        const gb = this.gb;
        if (this.stall > 0) {
            this.stall--;
            gb.tick();
            return;
        }
        if (this.halted) {
            gb.tick();
            if (gb.ie & gb.if & 0x1f) this.halted = false;
            return;
        }
        if (this.stopped || this.locked) {
            gb.tick();
            if (this.stopped && gb.joypad.pressed()) this.stopped = false;
            return;
        }
        if (this.ime && gb.ie & gb.if & 0x1f) {
            this.#interrupt();
            return;
        }
        if (this.imePending) {
            this.imePending = false;
            this.ime = true;
        }
        this.#execute(this.#fetch());
    }

    #interrupt() {
        const gb = this.gb;
        this.ime = false;
        gb.tick();
        gb.tick();
        gb.oamBug(this.sp);
        this.sp = (this.sp - 1) & 0xffff;
        this.#write(this.sp, this.pc >> 8);
        // Pushing the high byte can overwrite IE (SP = 0x0000), which changes or
        // cancels the interrupt being dispatched.
        const enabled = gb.ie;
        this.sp = (this.sp - 1) & 0xffff;
        this.#write(this.sp, this.pc & 0xff);
        const pending = enabled & gb.if & 0x1f;
        if (pending) {
            const bit = pending & -pending;
            gb.if &= ~bit;
            this.pc = 0x40 + 8 * (31 - Math.clz32(bit));
        } else {
            this.pc = 0;
        }
        gb.tick();
    }

    // --- Memory access (one M-cycle each) ------------------------------------

    #read(addr) {
        this.gb.tick();
        return this.gb.read(addr);
    }

    #write(addr, value) {
        this.gb.tick();
        this.gb.write(addr, value);
    }

    #fetch() {
        this.gb.tick();
        // HALT looks at the interrupts pending halfway through its opcode fetch.
        this.ifAtFetch = this.gb.ifMid;
        const value = this.gb.read(this.pc);
        if (this.haltBug) this.haltBug = false;
        else this.pc = (this.pc + 1) & 0xffff;
        return value;
    }

    #fetch16() {
        const low = this.#fetch();
        return low | (this.#fetch() << 8);
    }

    #push(value) {
        this.gb.tick();
        this.gb.oamBug(this.sp);
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
        const hl = this.hl;
        const r = hl + v;
        this.f = (this.f & Z) | ((hl & 0xfff) + (v & 0xfff) > 0xfff ? H : 0) | (r > 0xffff ? C : 0);
        this.gb.tick();
        this.hl = r & 0xffff;
    }

    /** SP + signed 8-bit offset; flags come from the unsigned low-byte addition. */
    #spOffset() {
        const e = this.#fetch();
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

    #jr(taken) {
        const e = this.#fetch();
        if (taken) {
            this.gb.tick();
            this.gb.oamBug(this.pc);
            this.pc = (this.pc + ((e << 24) >> 24)) & 0xffff;
        }
    }

    #jp(taken) {
        const addr = this.#fetch16();
        if (taken) {
            this.gb.tick();
            this.pc = addr;
        }
    }

    #call(taken) {
        const addr = this.#fetch16();
        if (taken) {
            this.#push(this.pc);
            this.pc = addr;
        }
    }

    #ret() {
        this.pc = this.#pop();
        this.gb.tick();
    }

    #rst(addr) {
        this.#push(this.pc);
        this.pc = addr;
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
                this.#write(hl, this.a);
                this.hl = (hl + 1) & 0xffff;
                break;
            }
            case 0x32: { // LD (HL-),A
                const hl = this.hl;
                this.#write(hl, this.a);
                this.hl = (hl - 1) & 0xffff;
                break;
            }
            case 0x03: case 0x13: case 0x23: case 0x33: { // INC rr
                const value = this.#getRp(op >> 4);
                this.gb.tick();
                this.gb.oamBug(value);
                this.#setRp(op >> 4, (value + 1) & 0xffff);
                break;
            }
            case 0x0b: case 0x1b: case 0x2b: case 0x3b: { // DEC rr
                const value = this.#getRp(op >> 4);
                this.gb.tick();
                this.gb.oamBug(value);
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
                this.a = this.#read(hl);
                this.hl = (hl + 1) & 0xffff;
                break;
            }
            case 0x3a: { // LD A,(HL-)
                const hl = this.hl;
                this.a = this.#read(hl);
                this.hl = (hl - 1) & 0xffff;
                break;
            }
            case 0x10: // STOP
                this.#fetch();
                if (this.gb.stop()) this.stopped = true;
                break;
            case 0x18: this.#jr(true); break;
            case 0x20: case 0x28: case 0x30: case 0x38: // JR cc
                this.#jr(this.#cond((op >> 3) & 3));
                break;
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
            case 0x76: // HALT
                if (this.gb.ie & this.ifAtFetch & 0x1f) {
                    // An interrupt is already pending. With IME just set (EI; HALT) it is
                    // taken right away and returns to the HALT; with IME off, the HALT
                    // bug: the next byte is read twice.
                    if (this.ime) this.pc = (this.pc - 1) & 0xffff;
                    else this.haltBug = true;
                } else {
                    this.halted = true;
                }
                break;

            case 0xc0: case 0xc8: case 0xd0: case 0xd8: // RET cc
                this.gb.tick();
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
            case 0xc2: case 0xca: case 0xd2: case 0xda: // JP cc
                this.#jp(this.#cond((op >> 3) & 3));
                break;
            case 0xc3: this.#jp(true); break;
            case 0xe9: this.pc = this.hl; break; // JP HL
            case 0xc4: case 0xcc: case 0xd4: case 0xdc: // CALL cc
                this.#call(this.#cond((op >> 3) & 3));
                break;
            case 0xcd: this.#call(true); break;
            case 0xc7: case 0xcf: case 0xd7: case 0xdf: case 0xe7: case 0xef: case 0xf7: case 0xff: // RST
                this.#rst(op & 0x38);
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
                const sp = this.#spOffset();
                this.gb.tick();
                this.gb.tick();
                this.sp = sp;
                break;
            }
            case 0xf8: { // LD HL,SP+e8
                const v = this.#spOffset();
                this.gb.tick();
                this.hl = v;
                break;
            }
            case 0xf9: // LD SP,HL
                this.gb.tick();
                this.gb.oamBug(this.hl);
                this.sp = this.hl;
                break;
            case 0xf3: // DI
                this.ime = false;
                this.imePending = false;
                break;
            case 0xfb: // EI
                this.imePending = true;
                break;

            case 0xd3: case 0xdb: case 0xdd: case 0xe3: case 0xe4: case 0xeb: case 0xec: case 0xed: case 0xf4: case 0xfc: case 0xfd:
                this.locked = true;
                break;

            default:
                if (op < 0x80) {
                    this.#setR((op >> 3) & 7, this.#getR(op & 7)); // LD r,r'
                } else {
                    this.#alu((op >> 3) & 7, this.#getR(op & 7)); // ALU A,r
                }
        }
    }
}
