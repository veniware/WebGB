import { createTestCore } from './test/test-core.js';

/**
 * Available cores. Add an entry here when a core is implemented.
 *
 * @type {import('./interface.js').CoreDescriptor[]}
 */
const cores = [
  { id: 'gb', name: 'Game Boy', systems: ['gb', 'gbc'], link: true, load: () => import('./gb/index.js') },
  { id: 'gba', name: 'Game Boy Advance', systems: ['gba'], load: () => import('./gba/index.js') },
];

export function registerCore(descriptor) {
  cores.push(descriptor);
}

export function findCore(system) {
  return cores.find((core) => core.systems.includes(system)) ?? null;
}

/**
 * Creates a core for the ROM. Until a real core supports the system, the
 * test core runs instead so the frontend can still be exercised.
 *
 * @param {Uint8Array} rom
 * @param {import('../rom/detect.js').RomInfo} info
 * @param {object} [options] Core options (see Core.configure)
 * @returns {Promise<{ core: import('./interface.js').Core, fallback: boolean }>}
 */
export async function createCore(rom, info, options = {}) {
  const descriptor = findCore(info.system);
  if (!descriptor) return { core: createTestCore(rom, info), fallback: true };
  const module = await descriptor.load();
  return { core: module.createCore(rom, info, options), fallback: false };
}

/** Whether a running core can be linked with another game (link cable). */
export function canLink(core, info) {
  return Boolean(core && (core.players ?? 1) === 1 && findCore(info.system)?.link);
}

/**
 * Links a second game to a running core; resolves to a two-player core
 * (see src/core/gb/link.js).
 */
export async function createLinkedCore(core, rom, info, options, layout) {
  const descriptor = findCore(info.system);
  if (!descriptor?.link || core.id !== descriptor.id) throw new Error('These games can\'t be linked.');
  const module = await descriptor.load();
  return module.createLinkedCore(core, rom, info, options, layout);
}
