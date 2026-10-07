import { detectRom } from "./detect.js";
import { extractZipEntry, isZip, listZip } from "./zip.js";
import { crc32 } from "../util/crc32.js";

const ROM_EXTENSION = /\.(gba|gbc|gb)$/i;
const MAX_SIZE = 64 * 1024 * 1024;

/**
 * @typedef {object} LoadedRom
 * @property {string} name         File name of the ROM (inside the zip, if zipped).
 * @property {Uint8Array} data
 * @property {import('./detect.js').RomInfo} info
 * @property {number} size
 * @property {string} key            Stable identity used to store saves and snapshots.
 */

/**
 * Reads a ROM from a File (plain or zipped) and identifies it.
 * @param {File} file
 * @returns {Promise<LoadedRom>}
 */
export async function loadRomFile(file) {
    if (file.size > MAX_SIZE) throw new Error(`${file.name} is too large to be a ROM.`);
    let data = new Uint8Array(await file.arrayBuffer());
    let name = file.name;
    if (isZip(data)) {
        const entry = listZip(data).find((e) => ROM_EXTENSION.test(e.name));
        if (!entry) throw new Error(`No .gb, .gbc or .gba file inside ${file.name}.`);
        if (entry.size > MAX_SIZE) throw new Error(`${entry.name} is too large to be a ROM.`);
        data = await extractZipEntry(data, entry);
        name = entry.name.split("/").pop();
    }
    const info = detectRom(data, name);
    const key = `${info.system}-${crc32(data).toString(16).padStart(8, "0")}-${data.length}`;
    return { key, name, info, size: data.length, data };
}
