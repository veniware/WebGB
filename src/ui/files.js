// File types the UI accepts.

export const ROM_ACCEPT = ".gb,.gbc,.gba,.zip";
export const SAVE_ACCEPT = ".sav,.srm";
export const SAVE_EXTENSION = /\.(sav|srm)$/i;
export const BACKUP_ACCEPT = ".zip";
export const BIOS_ACCEPT = ".bin,.rom,.bios";
// The GBA BIOS ROM is 16 KB.
export const GBA_BIOS_SIZE = 0x4000;

// Cartridge saves are at most 128 KB plus clock data, except MBC6 (1 MB of flash).
export const MAX_SAVE_SIZE = 2 * 1024 * 1024;
