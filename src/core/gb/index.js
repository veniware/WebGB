import { GameBoy } from './gameboy.js';
import { LinkedGameBoys } from './link.js';

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

/**
 * Connects a second Game Boy to a running one with a link cable.
 * @param {GameBoy} first
 * @param {{ vertical?: boolean }} [layout]
 */
export function createLinkedCore(first, rom, info, options, layout) {
  return new LinkedGameBoys(first, createCore(rom, info, options), layout);
}
