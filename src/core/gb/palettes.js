// Shades for the original Game Boy screen, lightest first, as 0xRRGGBB.
// A palette option in the UI can pick from these later.

export const DMG_PALETTES = {
  green: [0xe0f8d0, 0x88c070, 0x346856, 0x081820],
  gray: [0xffffff, 0xaaaaaa, 0x555555, 0x000000],
  classic: [0x9bbc0f, 0x8bac0f, 0x306230, 0x0f380f],
};

export const DEFAULT_DMG_PALETTE = DMG_PALETTES.green;

/** 0xRRGGBB -> pixel value for an RGBA Uint32Array on little-endian machines. */
export function rgbToPixel(rgb) {
  return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
}

/** CGB 15-bit BGR color -> RGBA pixel, scaling channels with (x << 3) | (x >> 2). */
export function cgbToPixel(color) {
  const r = color & 0x1f;
  const g = (color >> 5) & 0x1f;
  const b = (color >> 10) & 0x1f;
  return (0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2))) >>> 0;
}
