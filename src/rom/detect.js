/**
 * @typedef {object} RomInfo
 * @property {"gb" | "gbc" | "gba"} system
 * @property {string} title             Title from the cartridge header (may be empty).
 * @property {string} [code]            GBA game code.
 * @property {number} [cartType]    GB cartridge type byte (0x147).
 */

// First bytes of the Nintendo logo each header must contain.
const GB_LOGO = [0xce, 0xed, 0x66, 0x66];
const GBA_LOGO = [0x24, 0xff, 0xae, 0x51];

/**
 * Identifies the system from the cartridge header, falling back to the file
 * extension for homebrew with an incomplete header.
 *
 * @param {Uint8Array} data
 * @param {string} [fileName]
 * @returns {RomInfo}
 */
export function detectRom(data, fileName = "") {
    const ext = fileName.toLowerCase().split(".").pop();
    if (isGba(data)) return gbaInfo(data);
    if (isGb(data)) return gbInfo(data);
    if (ext === "gba" && data.length >= 0xc0) return gbaInfo(data);
    if ((ext === "gb" || ext === "gbc") && data.length >= 0x150) return { ...gbInfo(data), system: ext };
    throw new Error("Not a Game Boy or Game Boy Advance ROM.");
}

function isGba(data) {
    return data.length >= 0xc0 && data[0xb2] === 0x96 && startsWith(data, 0x04, GBA_LOGO);
}

function isGb(data) {
    return data.length >= 0x150 && startsWith(data, 0x104, GB_LOGO);
}

function gbaInfo(data) {
    return { system: "gba", title: ascii(data, 0xa0, 12), code: ascii(data, 0xac, 4) };
}

function gbInfo(rom) {
    // MMM01 compilations keep the header that describes them with their menu,
    // in the last 32 KiB; the first one belongs to the first game.
    const menu = rom.length - 0x8000;
    const data = menu > 0 && rom[menu + 0x147] >= 0x0b && rom[menu + 0x147] <= 0x0d &&
        startsWith(rom, menu + 0x104, GB_LOGO) ? rom.subarray(menu) : rom;
    const cgbFlag = data[0x143];
    const color = cgbFlag === 0x80 || cgbFlag === 0xc0;
    // Color-era headers shrink the title to make room for a manufacturer code.
    return { system: color ? "gbc" : "gb", title: ascii(data, 0x134, color ? 11 : 16), cartType: data[0x147] };
}

function startsWith(data, offset, bytes) {
    return bytes.every((byte, i) => data[offset + i] === byte);
}

function ascii(data, start, length) {
    let text = "";
    for (let i = start; i < start + length; i++) {
        const c = data[i];
        if (c === 0) break;
        text += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : " ";
    }
    return text.trim();
}
