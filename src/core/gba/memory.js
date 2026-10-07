import { bytesRegion } from '../memory.js';

/**
 * Memory regions of a GBA for the memory viewer, at their addresses on the
 * bus. Video memory is edited directly (the PPU reads it every line); I/O
 * writes go through the registers.
 *
 * @param {import('./gba.js').Gba} gba
 * @returns {import('../interface.js').MemoryRegion[]}
 */
export function memoryRegions(gba) {
  const { bus, ppu, backup } = gba;
  const regions = [
    bytesRegion('Work RAM (on board)', 0x02000000, bus.ewram),
    bytesRegion('Work RAM (in chip)', 0x03000000, bus.iwram),
    {
      name: 'I/O registers',
      base: 0x04000000,
      size: 0x400,
      read: (offset) => {
        const value = gba.read16(offset);
        return value < 0 ? -1 : (value >>> ((offset & 1) * 8)) & 0xff;
      },
      write: (offset, value) => gba.write8(offset, value),
    },
    bytesRegion('Palettes', 0x05000000, ppu.palette),
    bytesRegion('Video RAM', 0x06000000, ppu.vram),
    bytesRegion('Sprites (OAM)', 0x07000000, ppu.oam),
    bytesRegion('ROM', 0x08000000, bus.rom, null),
  ];
  if (backup.type !== 'none') {
    const data = backup.getSaveData();
    const kind = { sram: 'SRAM', flash64: 'Flash', flash128: 'Flash', eeprom: 'EEPROM' }[backup.type];
    regions.push(bytesRegion(`Save memory (${kind})`, backup.eeprom ? 0 : 0x0e000000, data, () => backup.writes++));
  }
  return regions;
}
