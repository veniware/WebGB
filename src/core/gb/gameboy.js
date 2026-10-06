import { StateReader, StateWriter } from '../state.js';
import { Apu, SAMPLE_RATE } from './apu.js';
import { createCartridge } from './cartridge.js';
import { CLOCK_RATE, FRAME_DOTS, SCREEN_HEIGHT, SCREEN_WIDTH } from './constants.js';
import { Cpu } from './cpu.js';
import { Joypad } from './joypad.js';
import { Ppu } from './ppu.js';
import { Serial } from './serial.js';
import { Timer } from './timer.js';

const STATE_MAGIC = 0x53424757; // "WGBS"
// M-cycles the CPU is held while switching speed.
const SPEED_SWITCH_CYCLES = 2050;

/**
 * Game Boy / Game Boy Color system: the memory map, I/O registers, OAM DMA
 * and HDMA, wiring the CPU to the other components. Implements the Core
 * interface (src/core/interface.js).
 *
 * The CPU drives time: each of its M-cycles calls tick(), which advances the
 * timer, PPU, APU, serial port and DMA. In CGB double speed an M-cycle is
 * 2 dots instead of 4, so the PPU and APU run at the same real-time speed.
 */
export class GameBoy {
  id = 'gb';
  version = 1;
  width = SCREEN_WIDTH;
  height = SCREEN_HEIGHT;
  fps = CLOCK_RATE / FRAME_DOTS;
  sampleRate = SAMPLE_RATE;

  /**
   * @param {Uint8Array} rom
   * @param {{ cgb?: boolean, now?: () => number }} [options]
   *   cgb: run as a Game Boy Color; now: wall clock for the cartridge RTC.
   */
  constructor(rom, { cgb = false, now } = {}) {
    this.cgb = cgb;
    this.cart = createCartridge(rom, { now });
    this.wram = new Uint8Array(cgb ? 0x8000 : 0x2000);
    this.hram = new Uint8Array(0x7f);
    // FF72-FF75: undocumented CGB registers.
    this.extraRegs = new Uint8Array(4);
    this.cpu = new Cpu(this);
    this.timer = new Timer(this);
    this.ppu = new Ppu(this);
    this.apu = new Apu(this);
    this.joypad = new Joypad(this);
    this.serial = new Serial(this);
    this.reset();
  }

  /** Power cycle. Battery-backed RAM and the RTC are kept. */
  reset() {
    this.wram.fill(0);
    this.hram.fill(0);
    this.extraRegs.fill(0);
    this.ie = 0;
    this.if = 0;
    this.svbk = 0;
    this.wramBank = 1;
    this.doubleSpeed = false;
    this.speedArmed = false;
    this.dmaRegister = 0xff;
    this.dmaSource = 0;
    this.dmaIndex = 0;
    // M-cycles until a requested OAM DMA starts copying.
    this.dmaDelay = 0;
    this.dmaActive = false;
    this.hdmaSource = 0;
    this.hdmaDest = 0;
    // Remaining 16-byte blocks minus one, as FF55 reads it.
    this.hdmaLength = 0x7f;
    this.hdmaActive = false;
    // Dots left in the current runFrame().
    this.frameBudget = 0;
    this.cart.reset();
    this.cpu.reset();
    this.ppu.reset();
    this.apu.reset();
    this.joypad.reset();
    this.serial.reset();
    this.#boot();
  }

  /** State the boot ROM leaves behind; the boot ROM itself isn't run (it's copyrighted). */
  #boot() {
    const cpu = this.cpu;
    if (this.cgb) {
      [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x11, 0x80, 0x00, 0x00, 0xff, 0x56, 0x00, 0x0d];
    } else {
      [cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.h, cpu.l] = [0x01, 0xb0, 0x00, 0x13, 0x00, 0xd8, 0x01, 0x4d];
    }
    cpu.sp = 0xfffe;
    cpu.pc = 0x0100;
    this.timer.reset(this.cgb ? 0x1ea0 : 0xabcc);
    this.joypad.select = 0;
    this.if = 0x01;

    // Sound registers as the boot chime leaves them (without retriggering it).
    const sound = [
      [0xff26, 0x80], [0xff10, 0x80], [0xff11, 0xbf], [0xff12, 0xf3], [0xff13, 0xff], [0xff14, 0x3f],
      [0xff16, 0x3f], [0xff17, 0x00], [0xff18, 0xff], [0xff19, 0x3f], [0xff1a, 0x7f], [0xff1b, 0xff],
      [0xff1c, 0x9f], [0xff1d, 0xff], [0xff1e, 0x3f], [0xff20, 0xff], [0xff21, 0x00], [0xff22, 0x00],
      [0xff23, 0x3f], [0xff24, 0x77], [0xff25, 0xf3],
    ];
    for (const [addr, value] of sound) this.apu.write(addr, value);
    this.apu.settle();

    this.ppu.writeRegister(0xff47, 0xfc);
    this.ppu.writeRegister(0xff40, 0x91);
  }

  sync(s) {
    this.cpu.sync(s);
    this.timer.sync(s);
    this.ppu.sync(s);
    this.apu.sync(s);
    this.joypad.sync(s);
    this.serial.sync(s);
    this.cart.sync(s);
    s.bytes(this.wram);
    s.bytes(this.hram);
    s.bytes(this.extraRegs);
    for (const r of ['ie', 'if', 'svbk', 'dmaRegister', 'dmaIndex', 'dmaDelay', 'hdmaLength']) this[r] = s.u8(this[r]);
    this.dmaSource = s.u16(this.dmaSource);
    this.hdmaSource = s.u16(this.hdmaSource);
    this.hdmaDest = s.u16(this.hdmaDest);
    for (const flag of ['doubleSpeed', 'speedArmed', 'dmaActive', 'hdmaActive']) this[flag] = s.bool(this[flag]);
    this.frameBudget = s.i32(this.frameBudget);
    this.wramBank = this.svbk || 1;
  }

  // --- Core interface ------------------------------------------------------------

  setInput(buttons) {
    this.joypad.setButtons(buttons);
  }

  /**
   * Runs until the PPU finishes a frame (VBlank), or for one frame's worth of
   * time while the LCD is off, so frames stay in step with the display.
   */
  runFrame() {
    const { cpu, ppu } = this;
    this.apu.beginFrame();
    ppu.frameDone = false;
    this.frameBudget += FRAME_DOTS;
    while (this.frameBudget > 0 && !ppu.frameDone) cpu.step();
    if (ppu.frameDone) this.frameBudget = 0;
    this.apu.catchUp();
  }

  getFrameBuffer() {
    return this.ppu.frontBytes;
  }

  getAudioSamples() {
    return this.apu.samples;
  }

  getSaveData() {
    return this.cart.getSaveData();
  }

  loadSaveData(data) {
    this.cart.loadSaveData(data);
  }

  saveState() {
    const s = new StateWriter();
    this.#header(s);
    this.sync(s);
    return s.finish();
  }

  loadState(data) {
    const s = new StateReader(data);
    if (!this.#header(s)) throw new Error('This snapshot is for a different game or system.');
    const backup = this.saveState();
    try {
      this.sync(s);
      if (!s.done) throw new Error('Invalid save state.');
    } catch (err) {
      const restore = new StateReader(backup);
      this.#header(restore);
      this.sync(restore);
      throw err;
    }
  }

  /** Writes or checks the state header (format, system, ROM size). */
  #header(s) {
    const magic = s.u32(STATE_MAGIC);
    const cgb = s.bool(this.cgb);
    const romSize = s.u32(this.cart.rom.length);
    return magic === STATE_MAGIC && cgb === this.cgb && romSize === this.cart.rom.length;
  }

  // --- Timing ----------------------------------------------------------------------

  /** Advances everything but the CPU by one M-cycle. */
  tick() {
    this.timer.tick();
    const dots = this.doubleSpeed ? 2 : 4;
    this.ppu.tick(dots);
    this.apu.pending += dots;
    if (this.serial.cycles) this.serial.tick();
    if (this.dmaDelay || this.dmaActive) this.#dmaTick();
    this.frameBudget -= dots;
  }

  /** STOP: resets DIV, then switches speed if armed (returns false) or stops the CPU (true). */
  stop() {
    this.timer.writeDiv();
    if (!this.cgb || !this.speedArmed) return true;
    this.speedArmed = false;
    this.doubleSpeed = !this.doubleSpeed;
    this.cpu.stall += SPEED_SWITCH_CYCLES;
    return false;
  }

  /** Called by the PPU at the start of each HBlank: runs one HDMA block. */
  hblank() {
    if (!this.hdmaActive) return;
    this.#hdmaBlock();
    this.cpu.stall += this.doubleSpeed ? 16 : 8;
    if (this.hdmaLength === 0) {
      this.hdmaLength = 0x7f;
      this.hdmaActive = false;
    } else {
      this.hdmaLength--;
    }
  }

  // --- Memory map ------------------------------------------------------------------

  read(addr) {
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.readVram(addr);
    if (addr < 0xc000) return this.cart.readRam(addr);
    if (addr < 0xfe00) return this.#readWram(addr);
    if (addr < 0xfea0) return this.dmaActive ? 0xff : this.ppu.readOam(addr);
    if (addr < 0xff00) return 0;
    if (addr < 0xff80) return this.#readIo(addr);
    if (addr < 0xffff) return this.hram[addr - 0xff80];
    return this.ie;
  }

  write(addr, value) {
    if (addr < 0x8000) this.cart.writeRom(addr, value);
    else if (addr < 0xa000) this.ppu.writeVram(addr, value);
    else if (addr < 0xc000) this.cart.writeRam(addr, value);
    else if (addr < 0xfe00) this.#writeWram(addr, value);
    else if (addr < 0xfea0) {
      if (!this.dmaActive) this.ppu.writeOam(addr, value);
    } else if (addr < 0xff00) {
      // Unusable area.
    } else if (addr < 0xff80) this.#writeIo(addr, value);
    else if (addr < 0xffff) this.hram[addr - 0xff80] = value;
    else this.ie = value;
  }

  /** C000-DFFF, mirrored at E000-FDFF. D000-DFFF is banked on the CGB. */
  #readWram(addr) {
    addr &= 0x1fff;
    return addr < 0x1000 ? this.wram[addr] : this.wram[(this.wramBank << 12) | (addr & 0xfff)];
  }

  #writeWram(addr, value) {
    addr &= 0x1fff;
    if (addr < 0x1000) this.wram[addr] = value;
    else this.wram[(this.wramBank << 12) | (addr & 0xfff)] = value;
  }

  #readIo(addr) {
    switch (addr) {
      case 0xff00: return this.joypad.read();
      case 0xff01: return this.serial.sb;
      case 0xff02: return this.serial.readSc();
      case 0xff04: return this.timer.div;
      case 0xff05: return this.timer.tima;
      case 0xff06: return this.timer.tma;
      case 0xff07: return this.timer.tac;
      case 0xff0f: return 0xe0 | this.if;
      case 0xff46: return this.dmaRegister;
    }
    if (addr < 0xff10) return 0xff;
    if (addr < 0xff40) return this.apu.read(addr);
    if (!this.cgb) return addr < 0xff4c ? this.ppu.readRegister(addr) : 0xff;
    switch (addr) {
      case 0xff4d: return 0x7e | (this.doubleSpeed ? 0x80 : 0) | (this.speedArmed ? 1 : 0);
      case 0xff55: return (this.hdmaActive ? 0 : 0x80) | this.hdmaLength;
      case 0xff70: return 0xf8 | this.svbk;
      case 0xff72: case 0xff73: case 0xff74: return this.extraRegs[addr - 0xff72];
      case 0xff75: return 0x8f | this.extraRegs[3];
      case 0xff76: case 0xff77: return this.apu.readPcm(addr);
    }
    return addr < 0xff70 ? this.ppu.readRegister(addr) : 0xff;
  }

  #writeIo(addr, value) {
    switch (addr) {
      case 0xff00: this.joypad.write(value); return;
      case 0xff01: this.serial.sb = value; return;
      case 0xff02: this.serial.writeSc(value); return;
      case 0xff04: this.timer.writeDiv(); return;
      case 0xff05: this.timer.writeTima(value); return;
      case 0xff06: this.timer.writeTma(value); return;
      case 0xff07: this.timer.writeTac(value); return;
      case 0xff0f: this.if = value & 0x1f; return;
      case 0xff46: this.#startDma(value); return;
    }
    if (addr < 0xff10) return;
    if (addr < 0xff40) {
      this.apu.write(addr, value);
      return;
    }
    if (!this.cgb) {
      if (addr < 0xff4c) this.ppu.writeRegister(addr, value);
      return;
    }
    switch (addr) {
      case 0xff4d: this.speedArmed = (value & 1) !== 0; return;
      case 0xff51: this.hdmaSource = (value << 8) | (this.hdmaSource & 0xff); return;
      case 0xff52: this.hdmaSource = (this.hdmaSource & 0xff00) | (value & 0xf0); return;
      case 0xff53: this.hdmaDest = ((value & 0x1f) << 8) | (this.hdmaDest & 0xff); return;
      case 0xff54: this.hdmaDest = (this.hdmaDest & 0x1f00) | (value & 0xf0); return;
      case 0xff55: this.#writeHdma(value); return;
      case 0xff70:
        this.svbk = value & 7;
        this.wramBank = this.svbk || 1;
        return;
      case 0xff72: case 0xff73: case 0xff74: this.extraRegs[addr - 0xff72] = value; return;
      case 0xff75: this.extraRegs[3] = value & 0x70; return;
    }
    if (addr < 0xff70) this.ppu.writeRegister(addr, value);
  }

  // --- DMA ---------------------------------------------------------------------------

  #startDma(value) {
    this.dmaRegister = value;
    // Sources from E000 up read work RAM, like its echo.
    this.dmaSource = (value >= 0xe0 ? value - 0x20 : value) << 8;
    // Copying starts two M-cycles after the write; a DMA already running
    // continues until then.
    this.dmaDelay = 2;
  }

  /** One byte per M-cycle; OAM stays blocked until the M-cycle after the last byte. */
  #dmaTick() {
    if (this.dmaActive) {
      if (this.dmaIndex === 0xa0) this.dmaActive = false;
      else this.#dmaCopy();
    }
    if (this.dmaDelay && --this.dmaDelay === 0) {
      this.dmaIndex = 0;
      this.dmaActive = true;
      this.#dmaCopy();
    }
  }

  #dmaCopy() {
    this.ppu.oam[this.dmaIndex] = this.#dmaRead(this.dmaSource + this.dmaIndex);
    this.dmaIndex++;
  }

  /** Reads for DMA, which bypasses the PPU's access restrictions. */
  #dmaRead(addr) {
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.vram[(this.ppu.vramBank << 13) | (addr & 0x1fff)];
    if (addr < 0xc000) return this.cart.readRam(addr);
    return this.#readWram(addr);
  }

  #writeHdma(value) {
    if (this.hdmaActive && !(value & 0x80)) {
      // Stops an HBlank transfer; FF55 then reads the remaining length with bit 7 set.
      this.hdmaActive = false;
      return;
    }
    this.hdmaLength = value & 0x7f;
    if (value & 0x80) {
      this.hdmaActive = true;
      return;
    }
    // General-purpose DMA: everything at once, with the CPU held meanwhile.
    const blocks = this.hdmaLength + 1;
    for (let i = 0; i < blocks; i++) this.#hdmaBlock();
    this.hdmaLength = 0x7f;
    this.cpu.stall += blocks * (this.doubleSpeed ? 16 : 8);
  }

  #hdmaBlock() {
    const { vram, vramBank } = this.ppu;
    for (let i = 0; i < 16; i++) {
      vram[(vramBank << 13) | this.hdmaDest] = this.#dmaRead(this.hdmaSource);
      this.hdmaSource = (this.hdmaSource + 1) & 0xffff;
      this.hdmaDest = (this.hdmaDest + 1) & 0x1fff;
    }
  }
}
