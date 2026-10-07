import { Gba } from "./gba.js";
import { LinkedGbas } from "./link.js";

/**
 * @param {Uint8Array} rom
 * @param {import("../../rom/detect.js").RomInfo} info
 * @param {object} [options] See Gba.configure(); gbaBios: a BIOS dump to run
 *     instead of the built-in one, gbaBiosIntro: start with its boot animation.
 */
export function createCore(rom, info, options = {}) {
    const core = new Gba(rom, { bios: options.gbaBios ?? null, biosIntro: options.gbaBiosIntro ?? false });
    core.configure(options);
    return core;
}

/**
 * Connects a second game to `first` with a link cable (see link.js).
 * @param {import("./gba.js").Gba} first
 * @param {Uint8Array | null} rom  null: a GBA without a cartridge, which waits
 *     for the first game to send it a program (multiboot).
 * @param {{ vertical?: boolean }} [layout]
 */
export function createLinkedCore(first, rom, info, options, layout) {
    const second = rom
        ? createCore(rom, info, options)
        : new Gba(new Uint8Array(0), { bios: options.gbaBios ?? null, cartless: true });
    return new LinkedGbas(first, second, layout);
}
