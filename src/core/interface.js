/**
 * The contract between the host (src/app/emulator.js) and emulator cores.
 *
 * The host only talks to cores through this interface, so a core can be
 * replaced, lazy-loaded, moved into a Worker or rewritten in WebAssembly
 * without touching rendering, audio, input or storage.
 *
 * @typedef {object} Core
 * @property {string} id          Stable identifier, stored with snapshots.
 * @property {number} version     Bump when the saveState() format changes.
 * @property {number} width       Frame width in pixels.
 * @property {number} height      Frame height in pixels.
 * @property {number} fps         Native frame rate (GB and GBA: ~59.7275).
 * @property {number} sampleRate  Rate of the samples from getAudioSamples().
 * @property {() => void} reset
 * @property {(buttons: number) => void} setInput  Bitmask of Button values.
 * @property {() => void} runFrame  Emulates exactly one video frame.
 * @property {() => Uint8ClampedArray} getFrameBuffer
 *   RGBA pixels, width * height * 4, rows from the top. May be reused between frames.
 * @property {() => Float32Array} getAudioSamples
 *   Interleaved stereo samples (L, R, ...) produced by the last runFrame().
 *   May be reused by the core; the host copies what it keeps.
 * @property {() => Uint8Array | null} getSaveData
 *   Battery-backed cartridge memory, or null when the cartridge has none.
 * @property {(data: Uint8Array) => void} loadSaveData
 * @property {() => Uint8Array} saveState
 * @property {(state: Uint8Array) => void} loadState
 */

/**
 * Registry entry for a core. `load` is called lazily so a core's code is
 * only downloaded when a ROM for it is opened.
 *
 * @typedef {object} CoreDescriptor
 * @property {string} id
 * @property {string} name
 * @property {Array<'gb' | 'gbc' | 'gba'>} systems
 * @property {() => Promise<{ createCore: (rom: Uint8Array, info: import('../rom/detect.js').RomInfo) => Core }>} load
 */

export {};
