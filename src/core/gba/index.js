import { Gba } from './gba.js';

/**
 * @param {Uint8Array} rom
 * @param {import('../../rom/detect.js').RomInfo} info
 * @param {object} [options] See Gba.configure(); gbaBios: a BIOS dump to run
 *   instead of the built-in one.
 */
export function createCore(rom, info, options = {}) {
  const core = new Gba(rom, { bios: options.gbaBios ?? null });
  core.configure(options);
  return core;
}
