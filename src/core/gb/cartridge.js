import { Cartridge } from './mappers/base.js';
import { Camera } from './mappers/camera.js';
import { Huc3 } from './mappers/huc3.js';
import { Huc1, Mbc1, Mbc2, Mbc3, Mbc5 } from './mappers/mbc.js';
import { Mbc6 } from './mappers/mbc6.js';
import { Mbc7 } from './mappers/mbc7.js';
import { Mmm01 } from './mappers/mmm01.js';
import { Tama5 } from './mappers/tama5.js';

// Cartridge RAM size by header byte 0x149.
const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

/**
 * Cartridge types by header byte 0x147: mapper class and features.
 * @type {Record<number, { mapper: typeof Cartridge, ram?: boolean, battery?: boolean, rtc?: boolean, rumble?: boolean }>}
 */
const TYPES = {
  0x00: { mapper: Cartridge },
  0x01: { mapper: Mbc1 },
  0x02: { mapper: Mbc1, ram: true },
  0x03: { mapper: Mbc1, ram: true, battery: true },
  0x05: { mapper: Mbc2 },
  0x06: { mapper: Mbc2, battery: true },
  0x08: { mapper: Cartridge, ram: true },
  0x09: { mapper: Cartridge, ram: true, battery: true },
  0x0b: { mapper: Mmm01 },
  0x0c: { mapper: Mmm01, ram: true },
  0x0d: { mapper: Mmm01, ram: true, battery: true },
  0x0f: { mapper: Mbc3, rtc: true, battery: true },
  0x10: { mapper: Mbc3, ram: true, rtc: true, battery: true },
  0x11: { mapper: Mbc3 },
  0x12: { mapper: Mbc3, ram: true },
  0x13: { mapper: Mbc3, ram: true, battery: true },
  0x19: { mapper: Mbc5 },
  0x1a: { mapper: Mbc5, ram: true },
  0x1b: { mapper: Mbc5, ram: true, battery: true },
  0x1c: { mapper: Mbc5, rumble: true },
  0x1d: { mapper: Mbc5, ram: true, rumble: true },
  0x1e: { mapper: Mbc5, ram: true, battery: true, rumble: true },
  0x20: { mapper: Mbc6 },
  0x22: { mapper: Mbc7 },
  0xfc: { mapper: Camera },
  0xfd: { mapper: Tama5 },
  0xfe: { mapper: Huc3, ram: true },
  0xff: { mapper: Huc1, ram: true, battery: true },
};

/**
 * Creates the cartridge (ROM, RAM, mapper) for a ROM image.
 * @param {Uint8Array} rom
 * @param {{ now?: () => number }} [options] Wall clock for real-time clocks.
 */
export function createCartridge(rom, { now } = {}) {
  const header = cartridgeHeader(rom);
  const typeByte = rom[header + 0x147];
  const type = TYPES[typeByte];
  if (!type) throw new Error(`Cartridge type 0x${typeByte.toString(16).padStart(2, '0')} is not supported yet.`);
  let ramSize = 0;
  if (type.mapper === Mbc2) ramSize = 512;
  else if (type.ram) ramSize = RAM_SIZES[rom[header + 0x149]] || 0x2000;
  return new type.mapper({ data: padRom(rom), ramSize, ...type, now });
}

/**
 * Offset of the header that describes the cartridge. MMM01 compilations
 * keep it with their menu in the last 32 KiB; the one at the start belongs
 * to the first game.
 */
export function cartridgeHeader(rom) {
  const menu = rom.length - 0x8000;
  if (menu > 0 && rom[menu + 0x147] >= 0x0b && rom[menu + 0x147] <= 0x0d) {
    let logo = true;
    for (let i = 0; i < 48 && logo; i++) logo = rom[menu + 0x104 + i] === rom[0x104 + i];
    if (logo) return menu;
  }
  return 0;
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
