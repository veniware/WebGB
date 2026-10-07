// Helpers for the cores' memory regions (see MemoryRegion in interface.js).

/**
 * A region backed by a byte array.
 * @param {string} name
 * @param {number} base  Address of the first byte.
 * @param {Uint8Array} data
 * @param {(() => void) | null} [changed]  Called after each write; null: read-only.
 * @returns {import('./interface.js').MemoryRegion}
 */
export function bytesRegion(name, base, data, changed) {
  return {
    name,
    base,
    size: data.length,
    read: (offset) => data[offset],
    write: changed === null ? null : (offset, value) => {
      data[offset] = value;
      changed?.();
    },
  };
}

/** Prefixes region names, e.g. with the player of a linked game. */
export function renamed(regions, prefix) {
  return regions.map((region) => ({ ...region, name: `${prefix}${region.name}` }));
}
