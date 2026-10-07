import { bytesRegion } from '../memory.js';

/**
 * Memory regions of a Game Boy for the memory viewer: the CPU's view (writes
 * go through the bus, so they reach the mapper and the I/O registers), then
 * the banked memories in full.
 *
 * @param {import('./gameboy.js').GameBoy} gb
 * @returns {import('../interface.js').MemoryRegion[]}
 */
export function memoryRegions(gb) {
  const { ppu, cart } = gb;
  const regions = [{
    name: 'CPU address space',
    base: 0,
    size: 0x10000,
    read: (addr) => peek(gb, addr),
    write: (addr, value) => gb.write(addr, value),
  }];
  if (gb.cgb) {
    regions.push(
      bytesRegion('Work RAM (banks 0-7)', 0, gb.wram),
      bytesRegion('Video RAM (banks 0-1)', 0, ppu.vram),
      bytesRegion('Background palettes', 0, ppu.bgPaletteRam, () => ppu.refreshPalettes()),
      bytesRegion('Sprite palettes', 0, ppu.objPaletteRam, () => ppu.refreshPalettes()),
    );
  }
  if (cart.ram.length) {
    const banked = cart.ram.length > 0x2000;
    regions.push(bytesRegion(banked ? 'Cartridge RAM (all banks)' : 'Cartridge RAM', banked ? 0 : 0xa000, cart.ram,
      () => gb.saveWrites++));
  }
  return regions;
}

/** Reads like the CPU, without its side effects (OAM bug, DMA conflicts) or access locks. */
function peek(gb, addr) {
  const { ppu } = gb;
  if (addr < 0x8000) return gb.cart.readRom(addr);
  if (addr < 0xa000) return ppu.vram[(ppu.vramBank << 13) | (addr & 0x1fff)];
  if (addr < 0xc000) return gb.cart.readRam(addr);
  if (addr < 0xfe00) {
    const offset = addr & 0x1fff;
    return gb.wram[offset < 0x1000 ? offset : (gb.wramBank << 12) | (offset & 0xfff)];
  }
  if (addr < 0xfea0) return ppu.oam[addr - 0xfe00];
  if (addr < 0xff00) return -1;
  if (addr < 0xff80) return gb.read(addr);
  if (addr < 0xffff) return gb.hram[addr - 0xff80];
  return gb.ie;
}
