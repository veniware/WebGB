import { GameBoy } from './gameboy.js';

/**
 * @param {Uint8Array} rom
 * @param {import('../../rom/detect.js').RomInfo} info
 * @param {object} [options] See GameBoy.configure().
 */
export function createCore(rom, info, options) {
  const core = new GameBoy(rom, { cgb: info.system === 'gbc' });
  core.configure(options);
  return core;
}
