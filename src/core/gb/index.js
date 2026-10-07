import { GameBoy } from "./gameboy.js";
import { LinkedGameBoys } from "./link.js";
import { supportsSgb } from "./sgb.js";

/**
 * @param {Uint8Array} rom
 * @param {import("../../rom/detect.js").RomInfo} info
 * @param {object} [options] See GameBoy.configure().
 */
export function createCore(rom, info, options = {}) {
    const cgb = info.system === "gbc";
    // Super Game Boy for the DMG games made for it, unless turned off.
    const sgb = !cgb && options.sgb !== false && supportsSgb(rom);
    const core = new GameBoy(rom, { cgb, sgb });
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
