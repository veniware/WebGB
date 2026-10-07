// ARM (32-bit) instructions of the ARM7TDMI. buildArmTable() returns one
// handler per decode index: bits 27-20 and 7-4 of the opcode.

/** 32-bit add, setting C and V on `cpu`. */
export function addFlags(cpu, a, b, carry = 0) {
  const result = (a + b + carry) | 0;
  cpu.c = (a >>> 0) + (b >>> 0) + carry > 0xffffffff ? 1 : 0;
  cpu.v = ((~(a ^ b) & (a ^ result)) >>> 31) & 1;
  return result;
}

/** 32-bit subtract (a - b - borrow), setting C (no borrow) and V on `cpu`. */
export function subFlags(cpu, a, b, borrow = 0) {
  const result = (a - b - borrow) | 0;
  cpu.c = (a >>> 0) - (b >>> 0) - borrow >= 0 ? 1 : 0;
  cpu.v = (((a ^ b) & (a ^ result)) >>> 31) & 1;
  return result;
}

export function setNZ(cpu, value) {
  cpu.n = (value >>> 31) & 1;
  cpu.z = value === 0 ? 1 : 0;
}

/**
 * The barrel shifter. Returns the shifted value and leaves the carry out in
 * `shifterCarry`. `byRegister`: amount from a register (0 means no shift,
 * and amounts of 32 or more are allowed); otherwise an immediate where 0
 * encodes LSR/ASR #32 and RRX.
 */
export const shifter = { carry: 0 };

export function shift(cpu, type, value, amount, byRegister) {
  switch (type) {
    case 0: // LSL
      if (amount === 0) {
        shifter.carry = cpu.c;
        return value;
      }
      if (amount < 32) {
        shifter.carry = (value >>> (32 - amount)) & 1;
        return value << amount;
      }
      shifter.carry = amount === 32 ? value & 1 : 0;
      return 0;
    case 1: // LSR
      if (amount === 0) {
        if (byRegister) {
          shifter.carry = cpu.c;
          return value;
        }
        amount = 32;
      }
      if (amount < 32) {
        shifter.carry = (value >>> (amount - 1)) & 1;
        return value >>> amount;
      }
      shifter.carry = amount === 32 ? (value >>> 31) & 1 : 0;
      return 0;
    case 2: // ASR
      if (amount === 0) {
        if (byRegister) {
          shifter.carry = cpu.c;
          return value;
        }
        amount = 32;
      }
      if (amount < 32) {
        shifter.carry = (value >> (amount - 1)) & 1;
        return value >> amount;
      }
      shifter.carry = (value >>> 31) & 1;
      return value >> 31;
    default: // ROR, RRX
      if (amount === 0) {
        if (byRegister) {
          shifter.carry = cpu.c;
          return value;
        }
        shifter.carry = value & 1;
        return (cpu.c << 31) | (value >>> 1);
      }
      amount &= 31;
      if (amount === 0) {
        shifter.carry = (value >>> 31) & 1;
        return value;
      }
      shifter.carry = (value >>> (amount - 1)) & 1;
      return (value >>> amount) | (value << (32 - amount));
  }
}

export function ror(value, amount) {
  amount &= 31;
  return amount ? (value >>> amount) | (value << (32 - amount)) : value;
}

/** Unsigned 32x32 -> 64-bit multiply: returns the low word, high word in `mul64.hi`. */
export const mul64 = { hi: 0 };

export function umul64(a, b) {
  const aLo = a & 0xffff;
  const aHi = a >>> 16;
  const bLo = b & 0xffff;
  const bHi = b >>> 16;
  const lolo = aLo * bLo;
  const hilo = aHi * bLo;
  const lohi = aLo * bHi;
  const mid = (lolo >>> 16) + (hilo & 0xffff) + (lohi & 0xffff);
  mul64.hi = (aHi * bHi + (hilo >>> 16) + (lohi >>> 16) + Math.floor(mid / 0x10000)) | 0;
  return ((mid << 16) | (lolo & 0xffff)) | 0;
}

/** Internal cycles of a multiply, from the multiplier's significant bytes. */
export function multiplyCycles(value, signed) {
  if (signed) value = value < 0 ? ~value : value;
  if ((value >>> 8) === 0) return 1;
  if ((value >>> 16) === 0) return 2;
  if ((value >>> 24) === 0) return 3;
  return 4;
}

export function buildArmTable(cpu) {
  const r = cpu.r;
  const bus = cpu.bus;
  const table = new Array(4096);

  // --- Data processing -------------------------------------------------------

  /** Operand 2 of a data-processing instruction; carry out in shifter.carry. */
  function operand2(op) {
    if (op & 0x02000000) {
      const rotate = ((op >>> 8) & 0xf) * 2;
      const value = ror(op & 0xff, rotate);
      shifter.carry = rotate ? (value >>> 31) & 1 : cpu.c;
      return value;
    }
    const rm = op & 0xf;
    const type = (op >>> 5) & 3;
    if (op & 0x10) {
      // Shift by register: one internal cycle, and the PC reads 4 further on.
      bus.idle(1);
      const value = rm === 15 ? r[15] + 4 : r[rm];
      return shift(cpu, type, value, r[(op >>> 8) & 0xf] & 0xff, true);
    }
    return shift(cpu, type, r[rm], (op >>> 7) & 0x1f, false);
  }

  function dataProcessing(op) {
    const opcode = (op >>> 21) & 0xf;
    const setFlags = (op & 0x00100000) !== 0;
    const rd = (op >>> 12) & 0xf;
    const rn = (op >>> 16) & 0xf;
    const b = operand2(op);
    let a = r[rn];
    if (rn === 15 && (op & 0x02000010) === 0x10) a += 4;
    let result = 0;
    let logical = false;
    switch (opcode) {
      case 0x0: result = a & b; logical = true; break; // AND
      case 0x1: result = a ^ b; logical = true; break; // EOR
      case 0x2: result = setFlags ? subFlags(cpu, a, b) : (a - b) | 0; break; // SUB
      case 0x3: result = setFlags ? subFlags(cpu, b, a) : (b - a) | 0; break; // RSB
      case 0x4: result = setFlags ? addFlags(cpu, a, b) : (a + b) | 0; break; // ADD
      case 0x5: result = setFlags ? addFlags(cpu, a, b, cpu.c) : (a + b + cpu.c) | 0; break; // ADC
      case 0x6: result = setFlags ? subFlags(cpu, a, b, 1 - cpu.c) : (a - b - (1 - cpu.c)) | 0; break; // SBC
      case 0x7: result = setFlags ? subFlags(cpu, b, a, 1 - cpu.c) : (b - a - (1 - cpu.c)) | 0; break; // RSC
      case 0x8: result = a & b; logical = true; break; // TST
      case 0x9: result = a ^ b; logical = true; break; // TEQ
      case 0xa: result = subFlags(cpu, a, b); break; // CMP
      case 0xb: result = addFlags(cpu, a, b); break; // CMN
      case 0xc: result = a | b; logical = true; break; // ORR
      case 0xd: result = b; logical = true; break; // MOV
      case 0xe: result = a & ~b; logical = true; break; // BIC
      default: result = ~b; logical = true; // MVN
    }
    const test = opcode >= 0x8 && opcode <= 0xb;
    if (setFlags) {
      if (rd === 15) {
        // Exception return: CPSR from SPSR (comparisons too, as on old ARMs).
        if (cpu.hasSpsr) cpu.cpsr = cpu.spsr;
      } else {
        setNZ(cpu, result);
        if (logical) cpu.c = shifter.carry;
      }
    }
    if (test) return;
    r[rd] = result;
    if (rd === 15) cpu.branch(result);
  }

  // --- PSR transfer ---------------------------------------------------------------

  function mrs(op) {
    r[(op >>> 12) & 0xf] = op & 0x00400000 ? cpu.spsr : cpu.cpsr;
  }

  function msr(op) {
    const value = op & 0x02000000 ? ror(op & 0xff, ((op >>> 8) & 0xf) * 2) : r[op & 0xf];
    let mask = 0;
    if (op & 0x00080000) mask |= 0xff000000;
    if (op & 0x00010000) mask |= 0x000000ff;
    if (op & 0x00400000) {
      if (cpu.hasSpsr) cpu.spsr = (cpu.spsr & ~mask) | (value & mask);
      return;
    }
    // User mode may only change the flags; the T bit isn't changed by MSR.
    if (cpu.mode === 0x10) mask &= 0xff000000;
    mask &= ~0x20;
    cpu.cpsr = (cpu.cpsr & ~mask) | (value & mask);
  }

  // --- Multiply -------------------------------------------------------------------

  function multiply(op) {
    const rd = (op >>> 16) & 0xf;
    const rs = r[(op >>> 8) & 0xf];
    let result = Math.imul(r[op & 0xf], rs);
    bus.idle(multiplyCycles(rs, true));
    if (op & 0x00200000) {
      result = (result + r[(op >>> 12) & 0xf]) | 0;
      bus.idle(1);
    }
    r[rd] = result;
    if (op & 0x00100000) setNZ(cpu, result);
    // The opcode fetch after the multiplier's internal cycles is non-sequential.
    bus.nonseq = true;
  }

  function multiplyLong(op) {
    const hiReg = (op >>> 16) & 0xf;
    const loReg = (op >>> 12) & 0xf;
    const a = r[op & 0xf];
    const b = r[(op >>> 8) & 0xf];
    const signed = (op & 0x00400000) !== 0;
    let lo = umul64(a, b);
    let hi = mul64.hi;
    if (signed) hi = (hi - (a < 0 ? b : 0) - (b < 0 ? a : 0)) | 0;
    bus.idle(multiplyCycles(b, signed) + 1);
    bus.nonseq = true;
    if (op & 0x00200000) {
      const sum = (lo >>> 0) + (r[loReg] >>> 0);
      lo = sum | 0;
      hi = (hi + r[hiReg] + (sum > 0xffffffff ? 1 : 0)) | 0;
      bus.idle(1);
    }
    r[loReg] = lo;
    r[hiReg] = hi;
    if (op & 0x00100000) {
      cpu.n = (hi >>> 31) & 1;
      cpu.z = lo === 0 && hi === 0 ? 1 : 0;
    }
  }

  // --- Loads and stores ---------------------------------------------------------

  function swap(op) {
    const address = r[(op >>> 16) & 0xf];
    const rd = (op >>> 12) & 0xf;
    const value = r[op & 0xf];
    if (op & 0x00400000) {
      const old = bus.read8(address);
      bus.write8(address, value);
      r[rd] = old;
    } else {
      const old = ror(bus.read32(address), (address & 3) * 8);
      bus.write32(address, value);
      r[rd] = old;
    }
    bus.idle(1);
  }

  function singleTransfer(op) {
    const rn = (op >>> 16) & 0xf;
    const rd = (op >>> 12) & 0xf;
    const load = (op & 0x00100000) !== 0;
    let offset;
    if (op & 0x02000000) {
      offset = shift(cpu, (op >>> 5) & 3, r[op & 0xf], (op >>> 7) & 0x1f, false);
    } else {
      offset = op & 0xfff;
    }
    if (!(op & 0x00800000)) offset = -offset;
    const base = r[rn];
    const pre = (op & 0x01000000) !== 0;
    const address = pre ? (base + offset) | 0 : base;
    // Post-indexing always writes back (the W bit then means user-mode access).
    const writeBack = !pre || (op & 0x00200000) !== 0;
    if (load) {
      const value = op & 0x00400000 ? bus.read8(address) : ror(bus.read32(address), (address & 3) * 8);
      if (writeBack) r[rn] = (base + offset) | 0;
      bus.idle(1);
      r[rd] = value;
      if (rd === 15) cpu.branch(value);
    } else {
      const value = rd === 15 ? r[15] + 4 : r[rd];
      if (op & 0x00400000) bus.write8(address, value);
      else bus.write32(address, value);
      if (writeBack) r[rn] = (base + offset) | 0;
    }
  }

  function halfwordTransfer(op) {
    const rn = (op >>> 16) & 0xf;
    const rd = (op >>> 12) & 0xf;
    const load = (op & 0x00100000) !== 0;
    let offset = op & 0x00400000 ? ((op >>> 4) & 0xf0) | (op & 0xf) : r[op & 0xf];
    if (!(op & 0x00800000)) offset = -offset;
    const base = r[rn];
    const pre = (op & 0x01000000) !== 0;
    const address = pre ? (base + offset) | 0 : base;
    const writeBack = !pre || (op & 0x00200000) !== 0;
    const sh = (op >>> 5) & 3;
    if (load) {
      let value;
      if (sh === 1) value = ror(bus.read16(address), (address & 1) * 8); // LDRH
      else if (sh === 2) value = (bus.read8(address) << 24) >> 24; // LDRSB
      else if (address & 1) value = (bus.read8(address) << 24) >> 24; // LDRSH, misaligned: a signed byte
      else value = (bus.read16(address) << 16) >> 16;
      if (writeBack) r[rn] = (base + offset) | 0;
      bus.idle(1);
      r[rd] = value;
      if (rd === 15) cpu.branch(value);
    } else {
      const value = rd === 15 ? r[15] + 4 : r[rd];
      bus.write16(address, value);
      if (writeBack) r[rn] = (base + offset) | 0;
    }
  }

  function blockTransfer(op) {
    const rn = (op >>> 16) & 0xf;
    const list = op & 0xffff;
    const load = (op & 0x00100000) !== 0;
    const up = (op & 0x00800000) !== 0;
    const pre = (op & 0x01000000) !== 0;
    let writeBack = (op & 0x00200000) !== 0;
    const userBank = (op & 0x00400000) !== 0 && !(load && list & 0x8000);
    const base = r[rn];
    let count = 0;
    for (let i = list; i; i &= i - 1) count++;
    // An empty list transfers R15 and moves the base by 16 words.
    const size = count ? count * 4 : 0x40;
    let address = up ? base : (base - size) | 0;
    if (pre === up) address = (address + 4) | 0;
    const newBase = up ? (base + size) | 0 : (base - size) | 0;
    if (!count) {
      if (load) {
        const value = bus.read32(address);
        r[rn] = newBase;
        cpu.branch(value);
      } else {
        bus.write32(address, r[15] + 4);
        r[rn] = newBase;
      }
      return;
    }
    let first = true;
    if (load) {
      if (list & (1 << rn)) writeBack = false;
      if (writeBack) r[rn] = newBase;
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        const value = bus.read32(address, !first);
        first = false;
        address = (address + 4) | 0;
        if (userBank) cpu.setUserReg(i, value);
        else r[i] = value;
      }
      bus.idle(1);
      if (list & 0x8000) {
        if (op & 0x00400000 && cpu.hasSpsr) cpu.cpsr = cpu.spsr;
        cpu.branch(r[15]);
      }
    } else {
      for (let i = 0; i < 16; i++) {
        if (!(list & (1 << i))) continue;
        let value = userBank ? cpu.getUserReg(i) : r[i];
        if (i === 15) value = r[15] + 4;
        bus.write32(address, value, !first);
        address = (address + 4) | 0;
        // The base is written back after the first store (it is stored
        // unchanged only when it is the first register in the list).
        if (first && writeBack) r[rn] = newBase;
        first = false;
      }
    }
  }

  // --- Branches and exceptions --------------------------------------------------

  function branch(op) {
    if (op & 0x01000000) r[14] = cpu.pc;
    cpu.branch(r[15] + ((op << 8) >> 6));
  }

  function branchExchange(op) {
    const target = r[op & 0xf];
    cpu.thumb = (target & 1) !== 0;
    cpu.branch(target);
  }

  function swi(op) {
    cpu.swi((op >>> 16) & 0xff);
  }

  function undefinedInstruction() {
    cpu.undefined();
  }

  // --- Decode ---------------------------------------------------------------------

  for (let index = 0; index < 4096; index++) {
    // Rebuild a representative opcode from the decode bits.
    const op = ((index & 0xff0) << 16) | ((index & 0xf) << 4);
    let handler = undefinedInstruction;
    if ((op & 0x0ffffff0) === 0x012fff10 || (index & 0xfff) === 0x121) handler = branchExchange;
    else if ((op & 0x0fc000f0) === 0x00000090) handler = multiply;
    else if ((op & 0x0f8000f0) === 0x00800090) handler = multiplyLong;
    else if ((op & 0x0fb000f0) === 0x01000090) handler = swap;
    else if ((op & 0x0e000090) === 0x00000090 && (op & 0x60)) handler = halfwordTransfer;
    else if ((op & 0x0fb00000) === 0x01000000 && !(op & 0x90)) handler = mrs;
    else if ((op & 0x0fb00000) === 0x01200000 && !(op & 0x90)) handler = msr;
    else if ((op & 0x0fb00000) === 0x03200000) handler = msr;
    else if ((op & 0x0c000000) === 0x00000000) handler = dataProcessing;
    else if ((op & 0x0e000010) === 0x06000010) handler = undefinedInstruction;
    else if ((op & 0x0c000000) === 0x04000000) handler = singleTransfer;
    else if ((op & 0x0e000000) === 0x08000000) handler = blockTransfer;
    else if ((op & 0x0e000000) === 0x0a000000) handler = branch;
    else if ((op & 0x0f000000) === 0x0f000000) handler = swi;
    table[index] = handler;
  }
  return table;
}
