# AGENTS.md

Guidance for AI agents (and humans) working on WebGB. **Keep this file up to
date**: when you add a module, change an interface, add a command or make a
design decision, update the relevant section in the same change.

## Project

Game Boy / Game Boy Color / Game Boy Advance emulator in plain JavaScript that
runs entirely in the browser (static files, no server-side processing).

Decisions so far:

- **Pure JavaScript, no WebAssembly.** Cores sit behind a fixed interface so a
  hot path could later be rewritten in Wasm without touching anything else.
- **No build step, no runtime dependencies.** Native ES modules; the browser
  loads `src/` directly. Don't add a bundler or npm packages without asking.
- **Game Boy core first**, then GBA. Until a core exists, ROMs run on the test
  core (`src/core/test/`).
- **Storage:** IndexedDB for saves and snapshots (too big for localStorage),
  localStorage for settings only.
- **No `SharedArrayBuffer`**: it needs COOP/COEP headers that plain static
  hosting can't set. Audio goes to the AudioWorklet with `postMessage`.
- **Mobile is a first-class target**: touch controls, responsive layout, safe
  areas. Check phone portrait and landscape when changing the UI.
- The UI is kept deliberately simple; the user fine-tunes it themselves.

## Commands

```sh
npm start   # dev server at http://localhost:8080 (tools/serve.js, no deps)
npm test    # node --test, runs tests/*.test.js
```

Run `npm test` before committing. For UI changes, also load the page in a
browser (Playwright and Chromium are usually available) and check the console
for errors at desktop and phone sizes.

## Architecture

```
index.html              Page shell: toolbar, stage, touch controls, status bar, dialog
src/main.js             Composition root: builds the modules and wires them together
src/styles.css          All styles (touch layout under @media (pointer: coarse))
src/app/
  emulator.js           Host: owns the core, runs the rAF loop, speed, saves, snapshots
  settings.js           Persisted user preferences (localStorage)
  emitter.js            Tiny event emitter
src/core/
  interface.js          The Core contract (JSDoc) and CoreDescriptor
  registry.js           System -> core lookup; lazy-loads cores with import()
  buttons.js            Button bitmask shared by input and cores
  test/test-core.js     Stand-in core: test pattern, button tones, save states
src/video/
  display.js            Canvas sizing (zoom, devicePixelRatio), fullscreen
  webgl-renderer.js     WebGL2 renderer, one shader program per filter
  canvas-renderer.js    2D-canvas fallback
  filters.js            Filter registry and GLSL (add filters here)
  thumbnail.js          Frame -> PNG blob for snapshot thumbnails
src/audio/
  audio-output.js       AudioContext + worklet node, batching, autoplay unlock
  audio-processor.js    AudioWorklet processor (audio thread)
  resampler.js          Ring buffer + resampler + dynamic rate control
src/input/
  input-manager.js      Merges sources; cancels opposite D-pad directions
  keyboard.js           Key map and hotkeys
  gamepad.js            Gamepad API polling
  touch.js              On-screen controls (multi-touch, slide between buttons)
src/rom/
  loader.js             File -> { name, data, info, key }; unzips
  detect.js             System detection from the cartridge header
  zip.js                Minimal zip reader (DecompressionStream)
src/storage/
  db.js                 IndexedDB open/upgrade and transaction helper
  saves.js              Battery saves, keyed by ROM key
  snapshots.js          Snapshot metadata and states (separate stores)
src/ui/
  ui.js                 Toolbar, drag-and-drop, status bar, hotkey actions
  snapshots-panel.js    Snapshot list dialog
src/util/crc32.js
tools/serve.js          Dev static server
tests/                  node:test unit tests (+ helpers.js for fake ROMs/zips)
```

### Data flow per animation frame

`Emulator.#tick` polls input once, computes how many emulated frames are due
from elapsed time × speed, then for each frame calls `core.runFrame()` and
pushes `core.getAudioSamples()` to `AudioOutput`. After the loop it flushes
audio once and draws the last frame buffer.

### Core interface

Defined in `src/core/interface.js`. A core exposes `width`, `height`, `fps`,
`sampleRate`, `id`, `version` and `reset`, `setInput(buttons)`, `runFrame()`,
`getFrameBuffer()` (RGBA `Uint8ClampedArray`), `getAudioSamples()`
(interleaved stereo `Float32Array`), `getSaveData`/`loadSaveData` and
`saveState`/`loadState`.

To add a core: create `src/core/<name>/index.js` exporting
`createCore(rom, info)`, then register it in `src/core/registry.js`. Bump the
core's `version` whenever its `saveState()` format changes; snapshots from
other versions are refused.

### Identities and storage

- ROM key: `<system>-<crc32>-<size>` (from `loader.js`). Saves and snapshots
  are keyed by it.
- IndexedDB `webgb`, version 1: `saves` (keyPath `romKey`), `snapshots`
  (metadata, autoIncrement `id`, index `romKey`), `snapshotStates` (`id` ->
  state bytes). Schema changes go in `db.js` `onupgradeneeded`, keyed on
  `event.oldVersion`, and bump `DB_VERSION`.
- Battery saves are written when they change (checked every 2 s, on tab hide
  and on pagehide).

## Conventions

- ES modules, 2-space indent, single quotes, semicolons, `camelCase`, classes
  in `PascalCase`. Private class members use `#fields`.
- Keep modules small and single-purpose; wire them together in `main.js`
  rather than importing across layers (e.g. cores never touch the DOM).
- No allocations in per-frame hot paths of cores (reuse typed arrays).
- Wrap localStorage access in try/catch; it can throw.
- Comments explain *why*, not *what*.
- Never commit ROMs (see `.gitignore`); open-source test ROMs may be
  re-included explicitly.

## Roadmap

1. Game Boy core: SM83 CPU, memory/MBCs, PPU, timer, APU, joypad.
2. Game Boy Color support.
3. GBA core (needs a BIOS: user-supplied file or high-level emulation).
4. Possibly later: key rebinding UI, PWA/offline install, rewind,
   audio/video recording.
