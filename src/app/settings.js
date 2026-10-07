// User preferences, kept in localStorage (small and synchronous).

const STORAGE_KEY = 'webgb.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  filter: 'sharp-bilinear',
  dedither: false,
  zoom: 'fit',
  volume: 0.8,
  // Game Boy: palette for DMG games (see GameBoy.configure) and GBC color correction.
  gbPalette: 'auto',
  colorCorrection: true,
  // Super Game Boy features for the games that have them (from the next start), and its border.
  sgb: true,
  sgbBorder: true,
});

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage blocked (private mode, disabled site data): settings just won't persist.
  }
}
