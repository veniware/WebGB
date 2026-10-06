import { Rtc, RTC_SAVE_SIZE } from './rtc.js';

// Cartridge RAM size by header byte 0x149.
const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

/**
 * Cartridge types by header byte 0x147: mapper and features.
 * @type {Record<number, { mapper: string, ram?: boolean, battery?: boolean, rtc?: boolean, rumble?: boolean }>}
 */
const TYPES = {
  0x00: { mapper: 'rom' },
  0x01: { mapper: 'mbc1' },
  0x02: { mapper: 'mbc1', ram: true },
  0x03: { mapper: 'mbc1', ram: true, battery: true },
  0x05: { mapper: 'mbc2' },
  0x06: { mapper: 'mbc2', battery: true },
  0x08: { mapper: 'rom', ram: true },
  0x09: { mapper: 'rom', ram: true, battery: true },
  0x0f: { mapper: 'mbc3', rtc: true, battery: true },
  0x10: { mapper: 'mbc3', ram: true, rtc: true, battery: true },
  0x11: { mapper: 'mbc3' },
  0x12: { mapper: 'mbc3', ram: true },
  0x13: { mapper: 'mbc3', ram: true, battery: true },
  0x19: { mapper: 'mbc5' },
  0x1a: { mapper: 'mbc5', ram: true },
  0x1b: { mapper: 'mbc5', ram: true, battery: true },
  0x1c: { mapper: 'mbc5', rumble: true },
  0x1d: { mapper: 'mbc5', ram: true, rumble: true },
  0x1e: { mapper: 'mbc5', ram: true, battery: true, rumble: true },
  0xff: { mapper: 'huc1', ram: true, battery: true },
};

/**
 * Creates the cartridge (ROM, RAM, mapper) for a ROM image.
 * @param {Uint8Array} rom
 * @param {{ now?: () => number }} [options] Wall clock for the MBC3 RTC.
 */
export function createCartridge(rom, { now } = {}) {
  const typeByte = rom[0x147];
  const type = TYPES[typeByte];
  if (!type) throw new Error(`Cartridge type 0x${typeByte.toString(16).padStart(2, '0')} is not supported yet.`);
  const data = padRom(rom);
  let ramSize = 0;
  if (type.mapper === 'mbc2') ramSize = 512;
  else if (type.ram) ramSize = RAM_SIZES[rom[0x149]] || 0x2000;
  const options = { data, ramSize, ...type, now };
  switch (type.mapper) {
    case 'mbc1': return new Mbc1(options);
    case 'mbc2': return new Mbc2(options);
    case 'mbc3': return new Mbc3(options);
    case 'mbc5': return new Mbc5(options);
    case 'huc1': return new Huc1(options);
    default: return new Cartridge(options);
  }
}

/** Pads the ROM to a power of two of at least 32 KB, so banks can be masked. */
function padRom(rom) {
  let size = 0x8000;
  while (size < rom.length) size *= 2;
  if (size === rom.length) return rom;
  const padded = new Uint8Array(size).fill(0xff);
  padded.set(rom);
  return padded;
}

/** ROM only (optionally with RAM); also the base class of the mappers. */
class Cartridge {
  constructor({ data, ramSize, battery = false, rtc = false, rumble = false, now }) {
    this.rom = data;
    this.ram = new Uint8Array(ramSize);
    this.hasBattery = battery;
    this.rtc = rtc ? new Rtc(now) : null;
    this.hasRumble = rumble;
    this.romMask = data.length / 0x4000 - 1;
    this.ramMask = Math.max(ramSize - 1, 0);
    this.reset();
  }

  /** Mapper registers back to power-on values. RAM (battery) and RTC are kept. */
  reset() {
    this.ramEnabled = this.constructor === Cartridge;
    this.romOffset0 = 0;
    this.romOffset1 = 0x4000;
    this.ramOffset = 0;
  }

  readRom(addr) {
    return addr < 0x4000 ? this.rom[this.romOffset0 + addr] : this.rom[this.romOffset1 + (addr & 0x3fff)];
  }

  /** Writes to 0000-7FFF set mapper registers. */
  writeRom(_addr, _value) {}

  readRam(addr) {
    if (!this.ramEnabled || !this.ram.length) return 0xff;
    return this.ram[(this.ramOffset + (addr & 0x1fff)) & this.ramMask];
  }

  writeRam(addr, value) {
    if (this.ramEnabled && this.ram.length) this.ram[(this.ramOffset + (addr & 0x1fff)) & this.ramMask] = value;
  }

  /** Battery-backed data for saved games, or null. */
  getSaveData() {
    if (!this.hasBattery) return null;
    if (!this.rtc) return this.ram;
    const data = new Uint8Array(this.ram.length + RTC_SAVE_SIZE);
    data.set(this.ram);
    data.set(this.rtc.toSave(), this.ram.length);
    return data;
  }

  loadSaveData(data) {
    this.ram.fill(0);
    this.ram.set(data.subarray(0, this.ram.length));
    const clock = data.subarray(this.ram.length);
    if (this.rtc && clock.length >= 44) this.rtc.fromSave(clock);
  }

  sync(s) {
    this.ramEnabled = s.bool(this.ramEnabled);
    this.romOffset0 = s.u32(this.romOffset0);
    this.romOffset1 = s.u32(this.romOffset1);
    this.ramOffset = s.u32(this.ramOffset);
    s.bytes(this.ram);
    this.rtc?.sync(s);
  }
}

class Mbc1 extends Cartridge {
  constructor(options) {
    super(options);
    // Multicarts wire only 4 bits of the low bank register; detected by a
    // second Nintendo logo at the start of bank 0x10.
    this.multicart = this.rom.length === 0x100000 && sameBytes(this.rom, 0x104, 0x40104, 48);
  }

  reset() {
    super.reset();
    this.bank1 = 1;
    this.bank2 = 0;
    this.mode = 0;
  }

  writeRom(addr, value) {
    switch (addr >> 13) {
      case 0: this.ramEnabled = (value & 0x0f) === 0x0a; break;
      case 1: this.bank1 = value & 0x1f || 1; break;
      case 2: this.bank2 = value & 3; break;
      default: this.mode = value & 1;
    }
    this.#update();
  }

  #update() {
    const shift = this.multicart ? 4 : 5;
    const low = this.multicart ? this.bank1 & 0x0f : this.bank1;
    const high = this.bank2 << shift;
    this.romOffset1 = ((high | low) & this.romMask) * 0x4000;
    this.romOffset0 = this.mode ? (high & this.romMask) * 0x4000 : 0;
    this.ramOffset = this.mode ? this.bank2 * 0x2000 : 0;
  }

  sync(s) {
    super.sync(s);
    this.bank1 = s.u8(this.bank1);
    this.bank2 = s.u8(this.bank2);
    this.mode = s.u8(this.mode);
  }
}

/** MBC2: 512 half-bytes of built-in RAM, mirrored across A000-BFFF. */
class Mbc2 extends Cartridge {
  writeRom(addr, value) {
    if (addr >= 0x4000) return;
    // Address bit 8 selects the register.
    if (addr & 0x100) this.romOffset1 = ((value & 0x0f || 1) & this.romMask) * 0x4000;
    else this.ramEnabled = (value & 0x0f) === 0x0a;
  }

  readRam(addr) {
    return this.ramEnabled ? this.ram[addr & 0x1ff] | 0xf0 : 0xff;
  }

  writeRam(addr, value) {
    if (this.ramEnabled) this.ram[addr & 0x1ff] = value & 0x0f;
  }
}

class Mbc3 extends Cartridge {
  reset() {
    super.reset();
    this.ramBank = 0;
    this.latchValue = 0xff;
  }

  writeRom(addr, value) {
    switch (addr >> 13) {
      case 0: this.ramEnabled = (value & 0x0f) === 0x0a; break;
      case 1: this.romOffset1 = ((value & 0x7f || 1) & this.romMask) * 0x4000; break;
      case 2:
        this.ramBank = value & 0x0f;
        this.ramOffset = (this.ramBank & 3) * 0x2000;
        break;
      default:
        if (this.latchValue === 0 && value === 1) this.rtc?.latch();
        this.latchValue = value;
    }
  }

  readRam(addr) {
    if (!this.ramEnabled) return 0xff;
    if (this.ramBank < 4) return super.readRam(addr);
    if (this.rtc && this.ramBank >= 8 && this.ramBank <= 0x0c) return this.rtc.read(this.ramBank);
    return 0xff;
  }

  writeRam(addr, value) {
    if (!this.ramEnabled) return;
    if (this.ramBank < 4) super.writeRam(addr, value);
    else if (this.rtc && this.ramBank >= 8 && this.ramBank <= 0x0c) this.rtc.write(this.ramBank, value);
  }

  sync(s) {
    super.sync(s);
    this.ramBank = s.u8(this.ramBank);
    this.latchValue = s.u8(this.latchValue);
  }
}

class Mbc5 extends Cartridge {
  reset() {
    super.reset();
    this.romBank = 1;
    this.rumbling = false;
  }

  writeRom(addr, value) {
    if (addr < 0x2000) {
      this.ramEnabled = (value & 0x0f) === 0x0a;
    } else if (addr < 0x3000) {
      this.romBank = (this.romBank & 0x100) | value;
    } else if (addr < 0x4000) {
      this.romBank = (this.romBank & 0xff) | ((value & 1) << 8);
    } else if (addr < 0x6000) {
      // On rumble cartridges bit 3 drives the motor instead of selecting RAM.
      this.rumbling = this.hasRumble && (value & 0x08) !== 0;
      this.ramOffset = (value & (this.hasRumble ? 0x07 : 0x0f)) * 0x2000;
    }
    this.romOffset1 = (this.romBank & this.romMask) * 0x4000;
  }

  sync(s) {
    super.sync(s);
    this.romBank = s.u16(this.romBank);
    this.rumbling = s.bool(this.rumbling);
  }
}

/** HuC1: an MBC1-like mapper with an infrared port (not emulated). */
class Huc1 extends Cartridge {
  writeRom(addr, value) {
    switch (addr >> 13) {
      case 0: this.ramEnabled = (value & 0x0f) !== 0x0e; break; // 0x0E selects IR mode
      case 1: this.romOffset1 = ((value & 0x3f || 1) & this.romMask) * 0x4000; break;
      case 2: this.ramOffset = (value & 3) * 0x2000; break;
    }
  }
}

function sameBytes(data, a, b, length) {
  for (let i = 0; i < length; i++) if (data[a + i] !== data[b + i]) return false;
  return true;
}
