import { buildArmTable } from './arm.js';
import { IdleLoops } from './idle.js';
import { buildThumbTable } from './thumb.js';

/** Processor modes (CPSR bits 0-4). */
export const Mode = {
  USR: 0x10, FIQ: 0x11, IRQ: 0x12, SVC: 0x13, ABT: 0x17, UND: 0x1b, SYS: 0x1f,
};

// Register banks: R13, R14 and SPSR are banked per mode (User and System share).
const BANK = new Int8Array(32).fill(0);
BANK[Mode.FIQ] = 1;
BANK[Mode.IRQ] = 2;
BANK[Mode.SVC] = 3;
BANK[Mode.ABT] = 4;
BANK[Mode.UND] = 5;

// Condition codes against the NZCV nibble: CONDITIONS[cond << 4 | nzcv].
const CONDITIONS = new Uint8Array(256);
for (let cond = 0; cond < 16; cond++) {
  for (let flags = 0; flags < 16; flags++) {
    const n = (flags >> 3) & 1;
    const z = (flags >> 2) & 1;
    const c = (flags >> 1) & 1;
    const v = flags & 1;
    const pass = [z, !z, c, !c, n, !n, v, !v, c && !z, !c || z, n === v, n !== v, !z && n === v, z || n !== v, 1, 0][cond];
    CONDITIONS[(cond << 4) | flags] = pass ? 1 : 0;
  }
}

/**
 * ARM7TDMI: the GBA's CPU, ARM (32-bit) and Thumb (16-bit) instruction sets.
 *
 * `pc` is the address of the next instruction to execute; while an
 * instruction runs, r[15] reads as its address + 8 (ARM) or + 4 (Thumb), as
 * the pipeline makes it on hardware. Instructions that write the PC call
 * branch(). Memory goes through `bus`, which also counts cycles.
 */
export class Arm7 {
  /**
   * @param {import('./bus.js').Bus} bus
   * @param {{ swi?: (cpu: Arm7, comment: number) => boolean, onIrqEnable?: () => void,
   *   onLoop?: (cpu: Arm7, target: number) => void }} [hooks]
   *   swi: high-level BIOS; returns true when it handled the call. onLoop: a
   *   short backward branch is about to be taken (see idle.js).
   */
  constructor(bus, hooks = {}) {
    this.bus = bus;
    this.hooks = hooks;
    this.r = new Int32Array(16);
    this.bankSp = new Int32Array(6);
    this.bankLr = new Int32Array(6);
    this.bankSpsr = new Int32Array(6);
    // R8-R12: FIQ mode has its own; the others are kept here meanwhile.
    this.fiqRegs = new Int32Array(5);
    this.usrRegs = new Int32Array(5);
    this.armTable = buildArmTable(this);
    this.thumbTable = buildThumbTable(this);
    this.reset();
  }

  reset() {
    this.r.fill(0);
    this.bankSp.fill(0);
    this.bankLr.fill(0);
    this.bankSpsr.fill(0);
    this.fiqRegs.fill(0);
    this.usrRegs.fill(0);
    this.n = 0;
    this.z = 0;
    this.c = 0;
    this.v = 0;
    this.irqDisable = true;
    this.fiqDisable = true;
    this.thumb = false;
    this.mode = Mode.SVC;
    this.pc = 0;
    this.halted = false;
    // The three-stage pipeline: the opcodes at pc and pc + 2/4 were fetched
    // before the instruction ahead of them ran (self-modifying code can't
    // change them); `refill` after a jump.
    this.pipeA = 0;
    this.pipeB = 0;
    this.refill = true;
  }

  sync(s) {
    s.bytes(this.r);
    s.bytes(this.bankSp);
    s.bytes(this.bankLr);
    s.bytes(this.bankSpsr);
    s.bytes(this.fiqRegs);
    s.bytes(this.usrRegs);
    for (const flag of ['n', 'z', 'c', 'v']) this[flag] = s.u8(this[flag]);
    for (const flag of ['irqDisable', 'fiqDisable', 'thumb', 'halted']) this[flag] = s.bool(this[flag]);
    this.mode = s.u8(this.mode);
    this.pc = s.u32(this.pc >>> 0) | 0;
    this.pipeA = s.i32(this.pipeA);
    this.pipeB = s.i32(this.pipeB);
    this.refill = s.bool(this.refill);
  }

  get cpsr() {
    return (this.n << 31) | (this.z << 30) | (this.c << 29) | (this.v << 28) |
      (this.irqDisable ? 0x80 : 0) | (this.fiqDisable ? 0x40 : 0) | (this.thumb ? 0x20 : 0) | this.mode;
  }

  set cpsr(value) {
    this.setFlags(value);
    const enabled = this.irqDisable && !(value & 0x80);
    this.irqDisable = (value & 0x80) !== 0;
    if (enabled) this.hooks.onIrqEnable?.();
    this.fiqDisable = (value & 0x40) !== 0;
    this.thumb = (value & 0x20) !== 0;
    this.switchMode(value & 0x1f);
  }

  setFlags(value) {
    this.n = (value >>> 31) & 1;
    this.z = (value >>> 30) & 1;
    this.c = (value >>> 29) & 1;
    this.v = (value >>> 28) & 1;
  }

  get spsr() {
    const bank = BANK[this.mode];
    return bank ? this.bankSpsr[bank] : this.cpsr;
  }

  set spsr(value) {
    const bank = BANK[this.mode];
    if (bank) this.bankSpsr[bank] = value;
  }

  /** Whether the mode has an SPSR (not User/System). */
  get hasSpsr() {
    return BANK[this.mode] !== 0;
  }

  switchMode(mode) {
    if (!BANK[mode] && mode !== Mode.USR && mode !== Mode.SYS) mode = Mode.SYS;
    const old = this.mode;
    if (old === mode) return;
    const r = this.r;
    const from = BANK[old];
    const to = BANK[mode];
    if (from !== to) {
      this.bankSp[from] = r[13];
      this.bankLr[from] = r[14];
      r[13] = this.bankSp[to];
      r[14] = this.bankLr[to];
    }
    if ((old === Mode.FIQ) !== (mode === Mode.FIQ)) {
      const [save, load] = mode === Mode.FIQ ? [this.usrRegs, this.fiqRegs] : [this.fiqRegs, this.usrRegs];
      for (let i = 0; i < 5; i++) {
        save[i] = r[8 + i];
        r[8 + i] = load[i];
      }
    }
    this.mode = mode;
  }

  /** User-mode view of R8-R14, for LDM/STM with the S bit. */
  getUserReg(i) {
    if (i >= 8 && i <= 12 && this.mode === Mode.FIQ) return this.usrRegs[i - 8];
    if ((i === 13 || i === 14) && BANK[this.mode]) return i === 13 ? this.bankSp[0] : this.bankLr[0];
    return this.r[i];
  }

  setUserReg(i, value) {
    if (i >= 8 && i <= 12 && this.mode === Mode.FIQ) this.usrRegs[i - 8] = value;
    else if ((i === 13 || i === 14) && BANK[this.mode]) {
      if (i === 13) this.bankSp[0] = value;
      else this.bankLr[0] = value;
    } else this.r[i] = value;
  }

  /** Jumps; the pipeline refills (an extra non-sequential fetch). */
  branch(address) {
    const target = (this.thumb ? address & ~1 : address & ~3) | 0;
    if (IdleLoops.isLoop(this.pc, target)) this.hooks.onLoop?.(this, target);
    this.pc = target;
    this.bus.branched = true;
    this.refill = true;
  }

  condition(cond) {
    return CONDITIONS[(cond << 4) | (this.n << 3) | (this.z << 2) | (this.c << 1) | this.v] === 1;
  }

  /** Takes an exception: saves CPSR, banks LR, jumps to the vector in ARM state. */
  exception(vector, mode, returnAddress) {
    const cpsr = this.cpsr;
    this.switchMode(mode);
    this.bankSpsr[BANK[mode]] = cpsr;
    this.r[14] = returnAddress;
    this.irqDisable = true;
    this.thumb = false;
    this.branch(vector);
  }

  /** An interrupt request (IRQ line high); taken unless disabled. */
  irq() {
    this.halted = false;
    if (this.irqDisable) return;
    this.exception(0x18, Mode.IRQ, this.pc + 4);
  }

  swi(comment) {
    if (this.hooks.swi?.(this, comment)) return;
    this.exception(0x08, Mode.SVC, this.pc);
  }

  undefined() {
    this.exception(0x04, Mode.UND, this.pc);
  }

  /** Executes one instruction. */
  step() {
    const bus = this.bus;
    const address = this.pc;
    if (this.thumb) {
      if (this.refill) {
        this.refill = false;
        this.pipeA = bus.peekCode16(address);
        this.pipeB = bus.peekCode16((address + 2) | 0);
      }
      const op = this.pipeA;
      this.pipeA = this.pipeB;
      this.pipeB = bus.fetch16((address + 4) | 0);
      this.pc = (address + 2) | 0;
      this.r[15] = address + 4;
      this.thumbTable[op >>> 6](op);
    } else {
      if (this.refill) {
        this.refill = false;
        this.pipeA = bus.peekCode32(address);
        this.pipeB = bus.peekCode32((address + 4) | 0);
      }
      const op = this.pipeA;
      this.pipeA = this.pipeB;
      this.pipeB = bus.fetch32((address + 8) | 0);
      this.pc = (address + 4) | 0;
      this.r[15] = address + 8;
      const cond = op >>> 28;
      if (cond === 14 || this.condition(cond)) this.armTable[((op >>> 16) & 0xff0) | ((op >>> 4) & 0xf)](op);
    }
  }
}
