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
- **Storage:** IndexedDB for the ROM library, saved games and snapshots (too
  big for localStorage), localStorage for settings only.
- **License:** MIT.
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
for errors at desktop and phone sizes. The page exposes `window.webgb`
(`emulator`, `display`, `audio`, `inputs`) for the console and for browser
tests, e.g. `webgb.emulator.core.getSaveData()`.

## Architecture

```
index.html              Page shell: toolbar, stage, touch controls, status bar, dialogs
src/main.js             Composition root: builds the modules and wires them together
src/styles.css          All styles (touch layout under @media (pointer: coarse))
src/app/
  emulator.js           Host: owns the core, runs the rAF loop, speed, launching,
                        in-game saves, snapshots
  settings.js           Persisted user preferences (localStorage)
  emitter.js            Tiny event emitter
src/core/
  interface.js          The Core contract (JSDoc) and CoreDescriptor
  registry.js           System -> core lookup; lazy-loads cores with import()
  buttons.js            Button bitmask shared by input and cores
  test/test-core.js     Stand-in core: test pattern, button tones, a Start-press
                        counter in battery RAM, save states
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
  roms.js               ROM library (metadata and bytes in separate stores)
  saves.js              Saved games (battery RAM), several per ROM
  snapshots.js          Snapshot metadata and states (separate stores)
src/ui/
  ui.js                 Toolbar, opening files, drag-and-drop, status bar, hotkeys
  library-dialog.js     Library: play, export, delete ROMs; add ROMs
  game-dialog.js        Per game: new game, saved games (play/import/export/delete),
                        snapshots (load/take/delete)
  modals.js             Shows dialogs; pauses the game and input while open
  dom.js                h() element helper, formatting, downloads, file picker
  files.js              Accepted file types and limits
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

### Library, saved games and snapshots

- Opening or dropping ROM files adds them to the library. Selecting a ROM
  (`selectRom` in `ui.js`) opens the game dialog when it has saved games or
  snapshots, otherwise starts a new game. Dropped `.sav`/`.srm` files are
  imported as saved games for the running ROM.
- If a ROM can't be stored (quota, storage blocked), it still runs from
  memory via `emulator.play(rom, data)`.
- A ROM can have several **saved games** (battery RAM). The running game
  writes to `emulator.saveId`; with none (new game), the first in-game save
  creates "Save N". If the active saved game is deleted, the next save creates
  a new one. Writes are serialized through a queue in `Emulator.flushSave()`.
- A **snapshot** records the `saveId` in use; resuming it switches back to
  that saved game (or to a new one if it was deleted or never existed).
- Deleting a ROM deletes its saved games and snapshots.
- Exported saved games are raw `.sav` files, compatible with other emulators.

### Identities and storage

- ROM key: `<system>-<crc32>-<size>` (from `loader.js`). Library entries,
  saved games and snapshots are keyed by it.
- IndexedDB `webgb`, version 1: `roms` (metadata, keyPath `key`), `romData`
  (`key` -> bytes), `saves` (autoIncrement `id`, index `romKey`), `snapshots`
  (metadata, autoIncrement `id`, index `romKey`), `snapshotStates` (`id` ->
  state bytes). Schema changes go in `db.js` `onupgradeneeded`, keyed on
  `event.oldVersion`, and bump `DB_VERSION`.
- In-game saves are written when they change (checked every 2 s, on tab hide
  and on pagehide).

### Input timing

Inputs report buttons pressed since the last poll even if already released,
and the host ORs input across animation frames that run no emulated frame,
so short taps are never lost.

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
   audio/video recording, full backup export/import of the library.
