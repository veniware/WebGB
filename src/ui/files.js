// File types the UI accepts.

export const ROM_ACCEPT = '.gb,.gbc,.gba,.zip';
export const SAVE_ACCEPT = '.sav,.srm';
export const SAVE_EXTENSION = /\.(sav|srm)$/i;

// Cartridge saves are at most 128 KB (plus a few bytes of clock data).
export const MAX_SAVE_SIZE = 1024 * 1024;
