// Screen colors: DMG shades, the palettes the Game Boy Color applies to
// original Game Boy games, and CGB color conversion.

/** Original-screen shades, lightest first, as 0xRRGGBB. */
export const DMG_PALETTES = {
    green: [0xe0f8d0, 0x88c070, 0x346856, 0x081820],
    gray: [0xffffff, 0xaaaaaa, 0x555555, 0x000000],
    classic: [0x9bbc0f, 0x8bac0f, 0x306230, 0x0f380f],
    pocket: [0xc4cfa1, 0x8b956d, 0x4d533c, 0x1f1f1f],
};

export const DEFAULT_DMG_PALETTE = DMG_PALETTES.green;

// --- Game Boy Color compatibility palettes ------------------------------------
// The CGB boot ROM colors Nintendo-published DMG games by a checksum of their
// title, and lets the player pick one of 12 palettes with button combinations.
// Data from SameBoy's open-source boot ROM (MIT), which matches the original.

// 4-color palettes, as 15-bit BGR colors.
const COLORS = [
    0x7fff, 0x32bf, 0x00d0, 0x0000, 0x639f, 0x4279, 0x15b0, 0x04cb, 0x7fff, 0x6e31, 0x454a, 0x0000,
    0x7fff, 0x1bef, 0x0200, 0x0000, 0x7fff, 0x421f, 0x1cf2, 0x0000, 0x7fff, 0x5294, 0x294a, 0x0000,
    0x7fff, 0x03ff, 0x012f, 0x0000, 0x7fff, 0x03ef, 0x01d6, 0x0000, 0x7fff, 0x42b5, 0x3dc8, 0x0000,
    0x7e74, 0x03ff, 0x0180, 0x0000, 0x67ff, 0x77ac, 0x1a13, 0x2d6b, 0x7ed6, 0x4bff, 0x2175, 0x0000,
    0x53ff, 0x4a5f, 0x7e52, 0x0000, 0x4fff, 0x7ed2, 0x3a4c, 0x1ce0, 0x03ed, 0x7fff, 0x255f, 0x0000,
    0x036a, 0x021f, 0x03ff, 0x7fff, 0x7fff, 0x01df, 0x0112, 0x0000, 0x231f, 0x035f, 0x00f2, 0x0009,
    0x7fff, 0x03ea, 0x011f, 0x0000, 0x299f, 0x001a, 0x000c, 0x0000, 0x7fff, 0x027f, 0x001f, 0x0000,
    0x7fff, 0x03e0, 0x0206, 0x0120, 0x7fff, 0x7eeb, 0x001f, 0x7c00, 0x7fff, 0x3fff, 0x7e00, 0x001f,
    0x7fff, 0x03ff, 0x001f, 0x0000, 0x03ff, 0x001f, 0x000c, 0x0000, 0x7fff, 0x033f, 0x0193, 0x0000,
    0x0000, 0x4200, 0x037f, 0x7fff, 0x7fff, 0x7e8c, 0x7c00, 0x0000, 0x7fff, 0x1bef, 0x6180, 0x0000,
];

// Combinations: offsets into COLORS of the OBJ0, OBJ1 and BG palettes. A few
// start mid-palette, as in the original ROM.
const COMBINATIONS = [
    [16, 16, 116], [72, 72, 72], [80, 80, 80], [96, 96, 96], [36, 36, 36], [0, 0, 0], [108, 108, 108],
    [20, 20, 20], [48, 48, 48], [104, 104, 104], [64, 32, 32], [16, 112, 112], [16, 8, 8], [12, 16, 16],
    [16, 116, 116], [112, 16, 112], [8, 68, 8], [64, 64, 32], [16, 16, 28], [16, 16, 72], [16, 16, 80],
    [76, 76, 36], [15, 15, 44], [68, 68, 8], [16, 16, 8], [16, 16, 12], [112, 112, 0], [12, 12, 0],
    [0, 0, 4], [72, 88, 72], [80, 88, 80], [96, 88, 96], [64, 88, 32], [68, 16, 52], [111, 0, 56],
    [111, 16, 60], [76, 91, 36], [64, 112, 40], [16, 92, 112], [68, 88, 8], [16, 0, 8], [16, 112, 12],
    [112, 12, 0], [12, 112, 16], [84, 112, 16], [12, 112, 0], [100, 12, 112], [0, 112, 32], [16, 12, 112],
    [112, 12, 24], [16, 112, 116],
];

// Title checksums; from index 65 on, the 4th title letter disambiguates.
const CHECKSUMS = [
    0x00, 0x88, 0x16, 0x36, 0xd1, 0xdb, 0xf2, 0x3c, 0x8c, 0x92, 0x3d, 0x5c, 0x58, 0xc9, 0x3e, 0x70, 0x1d,
    0x59, 0x69, 0x19, 0x35, 0xa8, 0x14, 0xaa, 0x75, 0x95, 0x99, 0x34, 0x6f, 0x15, 0xff, 0x97, 0x4b, 0x90,
    0x17, 0x10, 0x39, 0xf7, 0xf6, 0xa2, 0x49, 0x4e, 0x43, 0x68, 0xe0, 0x8b, 0xf0, 0xce, 0x0c, 0x29, 0xe8,
    0xb7, 0x86, 0x9a, 0x52, 0x01, 0x9d, 0x71, 0x9c, 0xbd, 0x5d, 0x6d, 0x67, 0x3f, 0x6b, 0xb3, 0x46, 0x28,
    0xa5, 0xc6, 0xd3, 0x27, 0x61, 0x18, 0x66, 0x6a, 0xbf, 0x0d, 0xf4, 0xb3, 0x46, 0x28, 0xa5, 0xc6, 0xd3,
    0x27, 0x61, 0x18, 0x66, 0x6a, 0xbf, 0x0d, 0xf4, 0xb3,
];
const FIRST_DUPLICATE = 65;
const FOURTH_LETTERS = "BEFAARBEKEK R-URAR INAILICE R";
// Combination per checksum entry.
const CHECKSUM_COMBINATIONS = [
    0, 4, 5, 35, 34, 3, 31, 15, 10, 5, 19, 36, 7, 37, 30, 44, 21, 32, 31, 20, 5, 33, 13, 14, 5, 29, 5, 18,
    9, 3, 2, 26, 25, 25, 41, 42, 26, 45, 42, 45, 36, 38, 26, 42, 30, 41, 34, 34, 5, 42, 6, 5, 33, 25, 42,
    42, 40, 2, 16, 25, 42, 42, 5, 0, 39, 36, 22, 25, 6, 32, 12, 36, 11, 39, 18, 39, 24, 31, 50, 17, 46, 6,
    27, 0, 47, 41, 41, 0, 0, 19, 34, 23, 18, 29,
];

/** The palettes picked with button combinations at power-on, by their usual names. */
export const GBC_PRESETS = {
    "gbc-brown": 5, // Up
    "gbc-red": 43, // Up + A
    "gbc-dark-brown": 28, // Up + B
    "gbc-blue": 48, // Left
    "gbc-dark-blue": 40, // Left + A
    "gbc-grayscale": 7, // Left + B
    "gbc-pastel": 8, // Down
    "gbc-orange": 3, // Down + A
    "gbc-yellow": 49, // Down + B
    "gbc-green": 1, // Right
    "gbc-dark-green": 0, // Right + A
    "gbc-inverted": 6, // Right + B
};

/**
 * @typedef {{ bg: number[], obj0: number[], obj1: number[] }} CompatPalette
 *     15-bit colors for the background and the two sprite palettes.
 */

/** @returns {CompatPalette} */
export function gbcCombination(index) {
    const [obj0, obj1, bg] = COMBINATIONS[index];
    const take = (offset) => COLORS.slice(offset, offset + 4);
    return { bg: take(bg), obj0: take(obj0), obj1: take(obj1) };
}

/**
 * The palette combination a Game Boy Color picks for a DMG game, or -1 when
 * it falls back to its default (games not published by Nintendo, unknown titles).
 * @param {Uint8Array} rom
 */
export function gbcCombinationFor(rom) {
    const nintendo = rom[0x14b] === 0x01 || (rom[0x14b] === 0x33 && rom[0x144] === 0x30 && rom[0x145] === 0x31);
    if (!nintendo) return -1;
    let checksum = 0;
    for (let i = 0x134; i < 0x144; i++) checksum += rom[i];
    checksum &= 0xff;
    for (let i = 0; i < CHECKSUMS.length; i++) {
        if (CHECKSUMS[i] !== checksum) continue;
        if (i < FIRST_DUPLICATE || FOURTH_LETTERS.charCodeAt(i - FIRST_DUPLICATE) === rom[0x137]) {
            return CHECKSUM_COMBINATIONS[i] || -1;
        }
    }
    return -1;
}

// --- Pixel values ----------------------------------------------------------------

/** 0xRRGGBB -> pixel value for an RGBA Uint32Array on little-endian machines. */
// --- Super Game Boy ------------------------------------------------------------
// The SGB's 32 built-in palettes (1-A to 4-H), 15-bit BGR, from SameBoy (MIT).
const SGB_COLORS = [
    0x67bf, 0x265b, 0x10b5, 0x2866, 0x637b, 0x3ad9, 0x0956, 0x0000, 0x7f1f, 0x2a7d, 0x30f3, 0x4ce7,
    0x57ff, 0x2618, 0x001f, 0x006a, 0x5b7f, 0x3f0f, 0x222d, 0x10eb, 0x7fbb, 0x2a3c, 0x0015, 0x0900,
    0x2800, 0x7680, 0x01ef, 0x2fff, 0x73bf, 0x46ff, 0x0110, 0x0066, 0x533e, 0x2638, 0x01e5, 0x0000,
    0x7fff, 0x2bbf, 0x00df, 0x2c0a, 0x7f1f, 0x463d, 0x74cf, 0x4ca5, 0x53ff, 0x03e0, 0x00df, 0x2800,
    0x433f, 0x72d2, 0x3045, 0x0822, 0x7ffa, 0x2a5f, 0x0014, 0x0003, 0x1eed, 0x215c, 0x42fc, 0x0060,
    0x7fff, 0x5ef7, 0x39ce, 0x0000, 0x4f5f, 0x630e, 0x159f, 0x3126, 0x637b, 0x121c, 0x0140, 0x0840,
    0x66bc, 0x3fff, 0x7ee0, 0x2c84, 0x5ffe, 0x3ebc, 0x0321, 0x0000, 0x63ff, 0x36dc, 0x11f6, 0x392a,
    0x65ef, 0x7dbf, 0x035f, 0x2108, 0x2b6c, 0x7fff, 0x1cd9, 0x0007, 0x53fc, 0x1f2f, 0x0e29, 0x0061,
    0x36be, 0x7eaf, 0x681a, 0x3c00, 0x7bbe, 0x329d, 0x1de8, 0x0423, 0x739f, 0x6a9b, 0x7293, 0x0001,
    0x5fff, 0x6732, 0x3da9, 0x2481, 0x577f, 0x3ebc, 0x456f, 0x1880, 0x6b57, 0x6e1b, 0x5010, 0x0007,
    0x0f96, 0x2c97, 0x0045, 0x3200, 0x67ff, 0x2f17, 0x2230, 0x1548,
];

/** Built-in SGB palettes by name ('1-A' ... '4-H'): 4 colors, lightest first. */
export const SGB_PALETTES = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [
    `${(i >> 3) + 1}-${"ABCDEFGH"[i & 7]}`,
    SGB_COLORS.slice(i * 4, i * 4 + 4),
]));

export function rgbToPixel(rgb) {
    return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
}

/**
 * CGB 15-bit BGR color -> RGBA pixel. Raw: channels scaled with
 * (x << 3) | (x >> 2). Corrected: mixed to look like the Game Boy Color's
 * LCD, which is less saturated than a modern screen.
 */
export function cgbToPixel(color, corrected = false) {
    const r = color & 0x1f;
    const g = (color >> 5) & 0x1f;
    const b = (color >> 10) & 0x1f;
    let R;
    let G;
    let B;
    if (corrected) {
        R = Math.min(960, r * 26 + g * 4 + b * 2) >> 2;
        G = Math.min(960, g * 24 + b * 8) >> 2;
        B = Math.min(960, r * 6 + g * 4 + b * 22) >> 2;
    } else {
        R = (r << 3) | (r >> 2);
        G = (g << 3) | (g >> 2);
        B = (b << 3) | (b >> 2);
    }
    return (0xff000000 | (B << 16) | (G << 8) | R) >>> 0;
}
