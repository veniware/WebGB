// Cheat finder for the memory viewer: finds the bytes of a region that hold
// a value, then narrows them down as the game runs (e.g. lives going down).

/** Conditions on a byte: its value now, the value searched for, its value at the last search. */
export const CONDITIONS = {
    equal: { name: "Equal to", test: (now, value) => now === value, needsValue: true },
    changed: { name: "Changed", test: (now, _, before) => now !== before },
    unchanged: { name: "Unchanged", test: (now, _, before) => now === before },
    increased: { name: "Increased", test: (now, _, before) => now > before },
    decreased: { name: "Decreased", test: (now, _, before) => now < before },
};

export class MemorySearch {
    /** @param {import("../core/interface.js").MemoryRegion} region */
    constructor(region) {
        this.region = region;
        // Candidate offsets, and their values at the last search.
        this.offsets = new Uint32Array(0);
        this.values = new Uint8Array(0);
        this.count = 0;
        this.started = false;
    }

    /**
     * A new search over the whole region. Without a value to compare with,
     * every readable byte is a candidate (narrow it down later).
     * @param {keyof CONDITIONS} condition
     * @param {number} value
     */
    start(condition, value) {
        const { region } = this;
        const offsets = new Uint32Array(region.size);
        const values = new Uint8Array(region.size);
        const { test, needsValue } = CONDITIONS[condition];
        let count = 0;
        for (let offset = 0; offset < region.size; offset++) {
            const now = region.read(offset);
            if (now < 0 || (needsValue && !test(now, value, now))) continue;
            offsets[count] = offset;
            values[count++] = now;
        }
        this.offsets = offsets;
        this.values = values;
        this.count = count;
        this.started = true;
    }

    /** Keeps the candidates that meet the condition now. */
    narrow(condition, value) {
        const { region, offsets, values } = this;
        const { test } = CONDITIONS[condition];
        let count = 0;
        for (let i = 0; i < this.count; i++) {
            const offset = offsets[i];
            const now = region.read(offset);
            if (now < 0 || !test(now, value, values[i])) continue;
            offsets[count] = offset;
            values[count++] = now;
        }
        this.count = count;
    }

    /** The first candidates: { offset, value } with the value now. */
    results(limit = 20) {
        const list = [];
        for (let i = 0; i < Math.min(limit, this.count); i++) {
            list.push({ offset: this.offsets[i], value: this.region.read(this.offsets[i]) });
        }
        return list;
    }
}

/** A byte value typed by the user: decimal, or hex with 0x or $. NaN if invalid. */
export function parseByte(text) {
    const trimmed = text.trim();
    const hex = /^(0x|\$)([0-9a-f]{1,2})$/i.exec(trimmed);
    const value = hex ? parseInt(hex[2], 16) : /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : NaN;
    return value >= 0 && value <= 255 ? value : NaN;
}
