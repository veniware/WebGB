import { createTestCore } from './test/test-core.js';

/**
 * Available cores. Add an entry here when a core is implemented.
 *
 * @type {import('./interface.js').CoreDescriptor[]}
 */
const cores = [
  { id: 'gb', name: 'Game Boy', systems: ['gb', 'gbc'], load: () => import('./gb/index.js') },
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
 * @returns {Promise<{ core: import('./interface.js').Core, fallback: boolean }>}
 */
export async function createCore(rom, info) {
  const descriptor = findCore(info.system);
  if (!descriptor) return { core: createTestCore(rom, info), fallback: true };
  const module = await descriptor.load();
  return { core: module.createCore(rom, info), fallback: false };
}
