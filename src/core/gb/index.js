import { GameBoy } from './gameboy.js';

/**
 * @param {Uint8Array} rom
 * @param {import('../../rom/detect.js').RomInfo} info
 */
export function createCore(rom, info) {
  return new GameBoy(rom, { cgb: info.system === 'gbc' });
}
