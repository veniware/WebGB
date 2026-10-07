import { StateReader, StateWriter } from '../state.js';
import { Apu, SAMPLE_RATE } from './apu.js';
import { Backup, detectBackup } from './backup.js';
import { bootState, createBios, createHleBios } from './bios.js';
import { Bus } from './bus.js';
import { Arm7 } from './cpu.js';
import { Dma, Timing } from './dma.js';
import { Gpio } from './gpio.js';
import { memoryRegions } from './memory.js';
import { LINE_CYCLES, Ppu, SCREEN_HEIGHT, SCREEN_WIDTH } from './ppu.js';
import { Sio } from './sio.js';
import { Timers } from './timers.js';

/** CPU clock: 2^24 Hz. */
export const CLOCK_RATE = 16777216;
export const FRAME_CYCLES = LINE_CYCLES * 228;
const STATE_MAGIC = 0x41424757; // "WGBA"
// States of a machine running a BIOS file: the CPU can be inside the BIOS,
// whose code differs from the built-in one, so they don't mix.
const STATE_MAGIC_BIOS = 0x42424757; // "WGBB"
// Cycles from an interrupt request to the CPU taking it, and from
// unmasking a pending one (CPSR) to taking it. Tuned against mGBA's suite.
const IRQ_DELAY = 5;
const UNMASK_DELAY = 2;

/** IE/IF and IME. */
class Interrupts {
  constructor(onChange) {
    this.onChange = onChange;
    this.ie = 0;
    this.if = 0;
    this.ime = false;
  }

  setMasterEnable(on) {
    this.ime = on;
    this.onChange();
  }

  request(bit, time) {
    this.if |= 1 << bit;
    this.onChange(time);
  }
}

/**
 * Game Boy Advance: wires the CPU, bus, PPU, APU, DMA, timers and
 * cartridge together, decodes the I/O registers and runs frames. Implements
 * the Core interface (src/core/interface.js).
 */
export class Gba {
  id = 'gba';
  version = 1;
  width = SCREEN_WIDTH;
  height = SCREEN_HEIGHT;
  fps = CLOCK_RATE / FRAME_CYCLES;
  sampleRate = SAMPLE_RATE;

  /**
   * @param {Uint8Array} rom
   * @param {{ bios?: Uint8Array | null, biosIntro?: boolean, now?: () => number }} [options]
   *   bios: a BIOS dump to use instead of the built-in calls; biosIntro: start
   *   with its boot animation instead of at the game.
   */
  constructor(rom, { bios = null, biosIntro = false, now } = {}) {
    this.rom = rom;
    this.ioRegs = new Uint16Array(0x200);
    this.irq = new Interrupts((time) => this.#updateIrq(time));
    this.backup = new Backup(detectBackup(rom));
    this.gpio = new Gpio(rom, { now });
    this.ppu = new Ppu({
      requestIrq: (bit, time) => this.irq.request(bit, time),
      onHblank: () => this.dma.trigger(Timing.HBLANK),
      onVblank: () => this.dma.trigger(Timing.VBLANK),
      onCaptureLine: (line) => this.dma.videoCapture(line),
    });
    this.realBios = bios;
    this.biosIntro = biosIntro;
    this.bus = new Bus({
      rom,
      bios: bios ? new Uint8Array(bios.slice(0, 0x4000)) : createBios(),
      io: this,
      ppu: this.ppu,
      backup: this.backup,
      gpio: this.gpio.present ? this.gpio : null,
    });
    this.timers = new Timers({
      now: () => this.bus.cycles,
      requestIrq: (bit, time) => this.irq.request(bit, time),
      onOverflow: (timer, time) => this.apu.timerOverflow(timer, time),
      feedsSound: (timer) => this.apu.usesTimer(timer),
      onSchedule: (time) => this.#schedule(time),
    });
    this.apu = new Apu({
      now: () => this.bus.cycles,
      requestFifo: (address) => this.dma.soundRequest(address),
      onTimerChange: () => this.timers.schedule(),
    });
    this.sio = new Sio({
      now: () => this.bus.cycles,
      requestIrq: (bit, time) => this.irq.request(bit, time),
      onSchedule: (time) => this.#schedule(time),
    });
    this.dma = new Dma(this.bus, {
      requestIrq: (bit) => this.irq.request(bit),
      eepromTransfer: (count) => this.backup.eepromTransfer(count),
    });
    const onIrqEnable = () => {
      // A pending interrupt is taken a few cycles after it gets unmasked.
      if (this.irqLine && this.irqReadyAt < this.bus.cycles) this.irqReadyAt = this.bus.cycles + UNMASK_DELAY;
      if (this.irqLine) this.#schedule(Math.max(this.bus.cycles, this.irqReadyAt));
    };
    this.cpu = new Arm7(this.bus, bios ? { onIrqEnable } : { swi: createHleBios(this), onIrqEnable });
    this.bus.cpu = this.cpu;
    this.buttons = 0;
    // When the next event (of the PPU, timers or APU) is due.
    this.eventTime = 0;
    this.reset();
  }

  reset() {
    this.bus.reset();
    this.ppu.reset();
    this.apu.reset();
    this.dma.reset();
    this.timers.reset();
    this.sio.reset();
    this.backup.reset();
    this.gpio.reset();
    this.ioRegs.fill(0);
    this.irq.ie = 0;
    this.irq.if = 0;
    this.irq.ime = false;
    this.irqLine = false;
    this.wakeLine = false;
    this.irqReadyAt = 0;
    this.keycnt = 0;
    this.postflg = 0;
    // Inside the BIOS's IntrWait (see bios.js).
    this.biosWaiting = false;
    this.frameStart = 0;
    if (this.realBios && this.biosIntro) {
      this.cpu.reset();
      this.cpu.branch(0);
    } else {
      bootState(this.cpu);
      this.postflg = 1;
    }
  }

  /** SoftReset: restarts the game (or the RAM-loaded program). */
  softReset(toEwram) {
    for (let a = 0x03007e00; a < 0x03008000; a += 4) this.bus.write32(a, 0);
    bootState(this.cpu);
    if (toEwram) this.cpu.branch(0x02000000);
  }

  /** An event got scheduled while the CPU runs. */
  #schedule(time) {
    if (time < this.eventTime) this.eventTime = time;
  }

  /** HALTCNT: wait for an enabled interrupt. */
  halt() {
    this.cpu.halted = true;
    this.eventTime = this.bus.cycles;
  }

  #updateIrq(time = this.bus.cycles) {
    const wake = (this.irq.ie & this.irq.if & 0x3fff) !== 0;
    const line = wake && this.irq.ime;
    if ((wake && !this.wakeLine) || (line && !this.irqLine)) this.irqReadyAt = time + IRQ_DELAY;
    this.wakeLine = wake;
    this.irqLine = line;
    if (wake) this.#schedule(Math.max(this.bus.cycles, this.irqReadyAt));
  }

  // --- I/O registers --------------------------------------------------------------

  /** Returns -1 for write-only and unused registers (open bus). */
  read16(address) {
    address &= 0x3fe;
    if (address < 0x60) return this.ppu.read16(address);
    if (address < 0xb0) return (address & 0xfc) === 0x8c || address >= 0xa0 ? -1 : this.apu.read16(address);
    if (address < 0xe0) return this.dma.read16(address);
    if (address < 0x100) return -1;
    if (address < 0x110) return this.timers.read16(address);
    if (address >= 0x120 && address < 0x15c && address !== 0x130 && address !== 0x132) return this.sio.read16(address);
    switch (address) {
      case 0x130: return ~this.buttons & 0x3ff;
      case 0x132: return this.keycnt;
      case 0x200: return this.irq.ie;
      case 0x202: return this.irq.if;
      case 0x204: return this.bus.waitControl;
      case 0x208: return this.irq.ime ? 1 : 0;
      case 0x300: return this.postflg;
      case 0x206: case 0x20a: case 0x302:
        return 0;
      default: return -1;
    }
  }

  write16(address, value) {
    address &= 0x3fe;
    this.ioRegs[address >> 1] = value;
    if (address < 0x60) this.ppu.write16(address, value);
    else if (address < 0xb0) this.apu.write16(address, value);
    else if (address < 0xe0) this.dma.write16(address, value);
    else if (address >= 0x100 && address < 0x110) this.timers.write16(address, value);
    else if (address >= 0x120 && address < 0x15c && address !== 0x130 && address !== 0x132) this.sio.write16(address, value);
    else {
      switch (address) {
        case 0x132:
          this.keycnt = value & 0xc3ff;
          this.#checkKeypadIrq();
          break;
        case 0x200: this.irq.ie = value & 0x3fff; this.#updateIrq(); break;
        case 0x202: this.irq.if &= ~value; this.#updateIrq(); break;
        case 0x204: this.bus.setWaitControl(value & 0x5fff); break;
        case 0x208: this.irq.setMasterEnable((value & 1) !== 0); break;
        case 0x300:
          this.postflg = value & 1;
          // HALTCNT (the high byte): bit 7 set is Stop, treated like Halt.
          this.halt();
          break;
      }
    }
  }

  write8(address, value) {
    const aligned = address & 0x3fe;
    if (aligned === 0x202) {
      this.irq.if &= ~(value << ((address & 1) * 8));
      this.#updateIrq();
      return;
    }
    if (address === 0x300) {
      this.postflg = value & 1;
      return;
    }
    if (address === 0x301) {
      this.halt();
      return;
    }
    if (address >= 0x60 && address < 0xb0) {
      this.apu.write8(address, value);
      return;
    }
    const old = this.ioRegs[aligned >> 1];
    const merged = address & 1 ? (old & 0xff) | (value << 8) : (old & 0xff00) | value;
    this.write16(aligned, merged);
  }

  #checkKeypadIrq() {
    if (!(this.keycnt & 0x4000)) return;
    const wanted = this.keycnt & 0x3ff;
    const pressed = this.buttons & wanted;
    const hit = this.keycnt & 0x8000 ? pressed === wanted : pressed !== 0;
    if (hit) this.irq.request(12);
  }

  // --- Core interface -------------------------------------------------------------

  setInput(buttons) {
    this.buttons = buttons & 0x3ff;
    this.#checkKeypadIrq();
  }

  /** User options: colorCorrection (look like the GBA's LCD). */
  configure({ colorCorrection = false } = {}) {
    this.ppu.setColorCorrection(colorCorrection);
  }

  getSaveWrites() {
    return this.backup.writes;
  }

  getMemoryRegions() {
    return memoryRegions(this);
  }

  /** Runs until the next VBlank (one frame). */
  runFrame() {
    const { cpu, bus, ppu } = this;
    ppu.frameDone = false;
    this.apu.beginFrame();
    const limit = bus.cycles + FRAME_CYCLES * 2;
    while (!ppu.frameDone && bus.cycles < limit) {
      this.eventTime = Math.min(ppu.nextEvent, this.timers.nextEvent, this.apu.nextEvent, this.sio.nextEvent);
      // Interrupts are taken between instructions once due; until then they
      // bring the next stop forward (as do HALT and newly scheduled events).
      if (this.irqLine && !cpu.irqDisable) {
        if (bus.cycles >= this.irqReadyAt) cpu.irq();
        else if (this.irqReadyAt < this.eventTime) this.eventTime = this.irqReadyAt;
      }
      if (cpu.halted) {
        if (!this.wakeLine) bus.cycles = this.eventTime;
        else if (bus.cycles >= this.irqReadyAt) cpu.halted = false;
        else bus.cycles = Math.min(this.irqReadyAt, this.eventTime);
      }
      while (bus.cycles < this.eventTime && !cpu.halted) cpu.step();
      const now = bus.cycles;
      if (ppu.nextEvent <= now) ppu.event(ppu.nextEvent);
      if (this.timers.nextEvent <= now) this.timers.event(now);
      if (this.apu.nextEvent <= now) this.apu.event(now);
      if (this.sio.nextEvent <= now) this.sio.event(now);
    }
    this.apu.endFrame();
  }

  getFrameBuffer() {
    return this.ppu.frontBytes;
  }

  getAudioSamples() {
    return this.apu.samples;
  }

  getSaveData() {
    // The clock's settings follow the save memory, if the game changed them.
    const clock = this.gpio.present ? this.gpio.toSave() : new Uint8Array(0);
    if (this.backup.type === 'none' && !clock.length && !this.backup.data.some((b) => b !== 0xff)) return null;
    const data = this.backup.getSaveData();
    if (!clock.length) return data;
    const out = new Uint8Array(data.length + clock.length);
    out.set(data);
    out.set(clock, data.length);
    return out;
  }

  loadSaveData(data) {
    // Save memory sizes are multiples of 512 bytes; 16 more are the clock.
    if (this.gpio.present && data.length % 512 === 16 && this.gpio.fromSave(data.subarray(data.length - 16))) {
      data = data.subarray(0, data.length - 16);
    }
    this.backup.loadSaveData(data);
  }

  saveState() {
    const s = new StateWriter();
    s.u32(this.realBios ? STATE_MAGIC_BIOS : STATE_MAGIC);
    s.u32(this.rom.length);
    this.#sync(s);
    return s.finish();
  }

  loadState(data) {
    const s = new StateReader(data);
    const magic = s.u32();
    if (magic === (this.realBios ? STATE_MAGIC : STATE_MAGIC_BIOS)) {
      throw new Error(this.realBios ? 'This snapshot was taken without the BIOS file.' : 'This snapshot was taken with the BIOS file.');
    }
    if (magic !== (this.realBios ? STATE_MAGIC_BIOS : STATE_MAGIC) || s.u32() !== this.rom.length) {
      throw new Error('This snapshot is for a different game or system.');
    }
    const backup = this.saveState();
    try {
      this.#sync(s);
      if (!s.done) throw new Error('Invalid save state.');
    } catch (err) {
      const restore = new StateReader(backup);
      restore.u32();
      restore.u32();
      this.#sync(restore);
      throw err;
    }
  }

  #sync(s) {
    // The time first: components work out their schedules from it.
    this.bus.cycles = s.f64(this.bus.cycles);
    this.cpu.sync(s);
    this.bus.sync(s);
    this.ppu.sync(s);
    this.apu.sync(s);
    this.dma.sync(s);
    this.timers.sync(s);
    this.sio.sync(s);
    this.backup.sync(s);
    this.gpio.sync(s);
    s.bytes(this.ioRegs);
    this.irq.ie = s.u16(this.irq.ie);
    this.irq.if = s.u16(this.irq.if);
    this.irq.ime = s.bool(this.irq.ime);
    this.keycnt = s.u16(this.keycnt);
    this.postflg = s.u8(this.postflg);
    this.biosWaiting = s.bool(this.biosWaiting);
    this.irqReadyAt = s.f64(this.irqReadyAt);
    this.wakeLine = false;
    this.irqLine = false;
    const readyAt = this.irqReadyAt;
    this.#updateIrq();
    this.irqReadyAt = readyAt;
  }
}
