// User preferences, kept in localStorage (small and synchronous).

const STORAGE_KEY = 'webgb.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  filter: 'sharp-bilinear',
  dedither: false,
  // Effects (WebGL): LCD ghosting (motion blur), sharpening, outlines (edge detection).
  ghosting: false,
  sharpen: false,
  outlines: false,
  zoom: 'fit',
  volume: 0.8,
  // 'auto' (WebGL when available), 'webgpu', 'webgl' or 'canvas'.
  renderer: 'auto',
  // Keep the last minute or so of play to rewind (hold the rewind key).
  rewind: true,
  // Status bar: emulated fps, speed and time per frame.
  perfStats: false,
  // Sound effects: pitch in semitones, filter cutoffs in Hz (0: off), echo preset.
  audioPitch: 0,
  audioLowpass: 0,
  audioHighpass: 0,
  audioEcho: 'off',
  // Bass boost in dB; both channels mixed together (mono).
  audioBass: 0,
  audioMono: false,
  // Changed controls (see src/input/bindings.js); null: the defaults.
  keyBindings: null,
  padBindings: null,
  // Game Boy: palette for DMG games (see GameBoy.configure) and GBC color correction.
  gbPalette: 'auto',
  colorCorrection: true,
  // Super Game Boy features for the games that have them (from the next start), and its border.
  sgb: true,
  sgbBorder: true,
  // GBA: boot through the BIOS file's intro (when one is loaded; the file is in IndexedDB).
  gbaBiosIntro: false,
  // GBA: light on Boktai's solar sensor, 0 (none) to 10.
  gbaSunlight: 0,
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
