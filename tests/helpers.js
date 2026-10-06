import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/util/crc32.js';

/** Minimal Game Boy ROM with a valid-looking header. */
export function makeGbRom({ title = 'TEST', cgb = 0x00, size = 0x8000 } = {}) {
  const rom = new Uint8Array(size);
  rom.set([0xce, 0xed, 0x66, 0x66], 0x104);
  rom.set(new TextEncoder().encode(title), 0x134);
  rom[0x143] = cgb;
  return rom;
}

/** Minimal GBA ROM with a valid-looking header. */
export function makeGbaRom({ title = 'TESTGAME', code = 'ATST', size = 0x1000 } = {}) {
  const rom = new Uint8Array(size);
  rom.set([0x24, 0xff, 0xae, 0x51], 0x04);
  rom.set(new TextEncoder().encode(title), 0xa0);
  rom.set(new TextEncoder().encode(code), 0xac);
  rom[0xb2] = 0x96;
  return rom;
}

/** Builds a zip archive. method 0 = stored, 8 = deflate. */
export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method = 8 } of entries) {
    const nameBytes = Buffer.from(name);
    const body = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
