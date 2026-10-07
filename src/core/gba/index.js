import { Gba } from './gba.js';

/**
 * @param {Uint8Array} rom
 * @param {import('../../rom/detect.js').RomInfo} info
 * @param {object} [options] See Gba.configure(); gbaBios: a BIOS dump to run
 *   instead of the built-in one, gbaBiosIntro: start with its boot animation.
 */
export function createCore(rom, info, options = {}) {
  const core = new Gba(rom, { bios: options.gbaBios ?? null, biosIntro: options.gbaBiosIntro ?? false });
  core.configure(options);
  return core;
}
