// Thumb (16-bit) instructions of the ARM7TDMI. buildThumbTable() returns one
// handler per decode index: the top 10 bits of the opcode.

import { addFlags, multiplyCycles, ror, setNZ, shift, shifter, subFlags } from './arm.js';

export function buildThumbTable(cpu) {
    const r = cpu.r;
    const bus = cpu.bus;
    const table = new Array(1024);

    // Format 1: LSL/LSR/ASR Rd, Rs, #imm5
    function shiftImmediate(op) {
        const rd = op & 7;
        const result = shift(cpu, (op >>> 11) & 3, r[(op >>> 3) & 7], (op >>> 6) & 0x1f, false);
        cpu.c = shifter.carry;
        setNZ(cpu, result);
        r[rd] = result;
    }

    // Format 2: ADD/SUB Rd, Rs, Rn / #imm3
    function addSub(op) {
        const a = r[(op >>> 3) & 7];
        const b = op & 0x0400 ? (op >>> 6) & 7 : r[(op >>> 6) & 7];
        const result = op & 0x0200 ? subFlags(cpu, a, b) : addFlags(cpu, a, b);
        setNZ(cpu, result);
        r[op & 7] = result;
    }

    // Format 3: MOV/CMP/ADD/SUB Rd, #imm8
    function immediate(op) {
        const rd = (op >>> 8) & 7;
        const value = op & 0xff;
        switch ((op >>> 11) & 3) {
            case 0: r[rd] = value; setNZ(cpu, value); break;
            case 1: setNZ(cpu, subFlags(cpu, r[rd], value)); break;
            case 2: setNZ(cpu, (r[rd] = addFlags(cpu, r[rd], value))); break;
            default: setNZ(cpu, (r[rd] = subFlags(cpu, r[rd], value)));
        }
    }

    // Format 4: ALU operations
    function alu(op) {
        const rd = op & 7;
        const rs = r[(op >>> 3) & 7];
        const a = r[rd];
        let result;
        switch ((op >>> 6) & 0xf) {
            case 0x0: result = r[rd] = a & rs; break; // AND
            case 0x1: result = r[rd] = a ^ rs; break; // EOR
            case 0x2: // LSL
            case 0x3: // LSR
            case 0x4: // ASR
            case 0x7: { // ROR
                const type = [0, 0, 0, 1, 2, 0, 0, 3][(op >>> 6) & 7];
                bus.idle(1);
                result = r[rd] = shift(cpu, type, a, rs & 0xff, true);
                cpu.c = shifter.carry;
                break;
            }
            case 0x5: result = r[rd] = addFlags(cpu, a, rs, cpu.c); break; // ADC
            case 0x6: result = r[rd] = subFlags(cpu, a, rs, 1 - cpu.c); break; // SBC
            case 0x8: result = a & rs; break; // TST
            case 0x9: result = r[rd] = subFlags(cpu, 0, rs); break; // NEG
            case 0xa: result = subFlags(cpu, a, rs); break; // CMP
            case 0xb: result = addFlags(cpu, a, rs); break; // CMN
            case 0xc: result = r[rd] = a | rs; break; // ORR
            case 0xd: // MUL
                bus.idle(multiplyCycles(a, true));
                bus.nonseq = true;
                result = r[rd] = Math.imul(a, rs);
                break;
            case 0xe: result = r[rd] = a & ~rs; break; // BIC
            default: result = r[rd] = ~rs; // MVN
        }
        setNZ(cpu, result);
    }

    // Format 5: ADD/CMP/MOV with high registers, BX
    function highRegister(op) {
        const rd = (op & 7) | ((op >>> 4) & 8);
        const rs = (op >>> 3) & 0xf;
        const value = r[rs];
        switch ((op >>> 8) & 3) {
            case 0: {
                const result = (r[rd] + value) | 0;
                r[rd] = result;
                if (rd === 15) cpu.branch(result);
                break;
            }
            case 1: setNZ(cpu, subFlags(cpu, r[rd], value)); break;
            case 2:
                r[rd] = value;
                if (rd === 15) cpu.branch(value);
                break;
            default:
                cpu.thumb = (value & 1) !== 0;
                cpu.branch(value);
        }
    }

    // Format 6: LDR Rd, [PC, #imm]
    function loadPcRelative(op) {
        const address = ((r[15] & ~2) + (op & 0xff) * 4) | 0;
        r[(op >>> 8) & 7] = bus.read32(address);
        bus.idle(1);
    }

    // Formats 7 and 8: loads and stores with a register offset
    function registerOffset(op) {
        const address = (r[(op >>> 3) & 7] + r[(op >>> 6) & 7]) | 0;
        const rd = op & 7;
        switch ((op >>> 9) & 7) {
            case 0: bus.write32(address, r[rd]); break; // STR
            case 1: bus.write16(address, r[rd]); break; // STRH
            case 2: bus.write8(address, r[rd]); break; // STRB
            case 3: r[rd] = (bus.read8(address) << 24) >> 24; bus.idle(1); break; // LDSB
            case 4: r[rd] = ror(bus.read32(address), (address & 3) * 8); bus.idle(1); break; // LDR
            case 5: r[rd] = ror(bus.read16(address), (address & 1) * 8); bus.idle(1); break; // LDRH
            case 6: r[rd] = bus.read8(address); bus.idle(1); break; // LDRB
            default: // LDSH (misaligned: a signed byte)
                r[rd] = address & 1 ? (bus.read8(address) << 24) >> 24 : (bus.read16(address) << 16) >> 16;
                bus.idle(1);
        }
    }

    // Format 9: LDR/STR/LDRB/STRB Rd, [Rb, #imm5]
    function immediateOffset(op) {
        const byte = (op & 0x1000) !== 0;
        const offset = (op >>> 6) & 0x1f;
        const address = (r[(op >>> 3) & 7] + (byte ? offset : offset * 4)) | 0;
        const rd = op & 7;
        if (op & 0x0800) {
            r[rd] = byte ? bus.read8(address) : ror(bus.read32(address), (address & 3) * 8);
            bus.idle(1);
        } else {
            if (byte) bus.write8(address, r[rd]);
            else bus.write32(address, r[rd]);
        }
    }

    // Format 10: LDRH/STRH Rd, [Rb, #imm5]
    function halfwordOffset(op) {
        const address = (r[(op >>> 3) & 7] + ((op >>> 6) & 0x1f) * 2) | 0;
        const rd = op & 7;
        if (op & 0x0800) {
            r[rd] = ror(bus.read16(address), (address & 1) * 8);
            bus.idle(1);
        } else {
            bus.write16(address, r[rd]);
        }
    }

    // Format 11: LDR/STR Rd, [SP, #imm]
    function spRelative(op) {
        const address = (r[13] + (op & 0xff) * 4) | 0;
        const rd = (op >>> 8) & 7;
        if (op & 0x0800) {
            r[rd] = ror(bus.read32(address), (address & 3) * 8);
            bus.idle(1);
        } else {
            bus.write32(address, r[rd]);
        }
    }

    // Format 12: ADD Rd, PC/SP, #imm
    function loadAddress(op) {
        const base = op & 0x0800 ? r[13] : r[15] & ~2;
        r[(op >>> 8) & 7] = (base + (op & 0xff) * 4) | 0;
    }

    // Format 13: ADD SP, #+-imm
    function adjustSp(op) {
        const offset = (op & 0x7f) * 4;
        r[13] = (r[13] + (op & 0x80 ? -offset : offset)) | 0;
    }

    // Format 14: PUSH/POP
    function pushPop(op) {
        const list = op & 0xff;
        const extra = (op & 0x0100) !== 0;
        let count = extra ? 1 : 0;
        for (let i = list; i; i &= i - 1) count++;
        if (op & 0x0800) { // POP
            let address = r[13];
            let first = true;
            for (let i = 0; i < 8; i++) {
                if (!(list & (1 << i))) continue;
                r[i] = bus.read32(address, !first);
                first = false;
                address = (address + 4) | 0;
            }
            if (extra) {
                const value = bus.read32(address, !first);
                address = (address + 4) | 0;
                r[13] = address;
                bus.idle(1);
                cpu.branch(value);
                return;
            }
            if (!count) { // empty list: R15, and SP moves 16 words
                cpu.branch(bus.read32(address));
                r[13] = (address + 0x40) | 0;
                return;
            }
            r[13] = address;
            bus.idle(1);
        } else { // PUSH
            if (!count) {
                r[13] = (r[13] - 0x40) | 0;
                bus.write32(r[13], r[15] + 2);
                return;
            }
            let address = (r[13] - count * 4) | 0;
            r[13] = address;
            let first = true;
            for (let i = 0; i < 8; i++) {
                if (!(list & (1 << i))) continue;
                bus.write32(address, r[i], !first);
                first = false;
                address = (address + 4) | 0;
            }
            if (extra) bus.write32(address, r[14], !first);
        }
    }

    // Format 15: LDMIA/STMIA Rb!, {list}
    function multiple(op) {
        const rb = (op >>> 8) & 7;
        const list = op & 0xff;
        let address = r[rb];
        if (!list) {
            // Empty list: R15, and the base moves 16 words.
            if (op & 0x0800) cpu.branch(bus.read32(address));
            else bus.write32(address, r[15] + 2);
            r[rb] = (address + 0x40) | 0;
            return;
        }
        let count = 0;
        for (let i = list; i; i &= i - 1) count++;
        const end = (address + count * 4) | 0;
        let first = true;
        if (op & 0x0800) {
            for (let i = 0; i < 8; i++) {
                if (!(list & (1 << i))) continue;
                r[i] = bus.read32(address, !first);
                first = false;
                address = (address + 4) | 0;
            }
            // The base isn't written back if it was loaded.
            if (!(list & (1 << rb))) r[rb] = end;
            bus.idle(1);
        } else {
            for (let i = 0; i < 8; i++) {
                if (!(list & (1 << i))) continue;
                bus.write32(address, r[i], !first);
                address = (address + 4) | 0;
                // The base is stored unchanged only when it is the first register.
                if (first) r[rb] = end;
                first = false;
            }
        }
    }

    // Format 16: conditional branch; format 17: SWI
    function conditionalBranch(op) {
        const cond = (op >>> 8) & 0xf;
        if (cond === 0xf) {
            cpu.swi(op & 0xff);
            return;
        }
        if (cond === 0xe) {
            cpu.undefined();
            return;
        }
        if (cpu.condition(cond)) cpu.branch(r[15] + (((op & 0xff) << 24) >> 23));
    }

    // Format 18: B
    function branch(op) {
        cpu.branch(r[15] + (((op & 0x7ff) << 21) >> 20));
    }

    // Format 19: BL, in two halves
    function branchLinkHigh(op) {
        r[14] = (r[15] + (((op & 0x7ff) << 21) >> 9)) | 0;
    }

    function branchLinkLow(op) {
        const target = (r[14] + (op & 0x7ff) * 2) | 0;
        r[14] = cpu.pc | 1;
        cpu.branch(target);
    }

    function undefinedInstruction() {
        cpu.undefined();
    }

    for (let index = 0; index < 1024; index++) {
        const op = index << 6;
        let handler = undefinedInstruction;
        if ((op & 0xf800) === 0x1800) handler = addSub;
        else if ((op & 0xe000) === 0x0000) handler = shiftImmediate;
        else if ((op & 0xe000) === 0x2000) handler = immediate;
        else if ((op & 0xfc00) === 0x4000) handler = alu;
        else if ((op & 0xfc00) === 0x4400) handler = highRegister;
        else if ((op & 0xf800) === 0x4800) handler = loadPcRelative;
        else if ((op & 0xf000) === 0x5000) handler = registerOffset;
        else if ((op & 0xe000) === 0x6000) handler = immediateOffset;
        else if ((op & 0xf000) === 0x8000) handler = halfwordOffset;
        else if ((op & 0xf000) === 0x9000) handler = spRelative;
        else if ((op & 0xf000) === 0xa000) handler = loadAddress;
        else if ((op & 0xff00) === 0xb000) handler = adjustSp;
        else if ((op & 0xf600) === 0xb400) handler = pushPop;
        else if ((op & 0xf000) === 0xc000) handler = multiple;
        else if ((op & 0xf000) === 0xd000) handler = conditionalBranch;
        else if ((op & 0xf800) === 0xe000) handler = branch;
        else if ((op & 0xf800) === 0xf000) handler = branchLinkHigh;
        else if ((op & 0xf800) === 0xf800) handler = branchLinkLow;
        table[index] = handler;
    }
    return table;
}
