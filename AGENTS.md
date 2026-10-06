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
- **Game Boy / Game Boy Color core done** (`src/core/gb/`); the GBA core is
  next. Until it exists, GBA ROMs run on the test core (`src/core/test/`).
- **No boot ROMs** (they're copyrighted): cores start in the state the boot
  ROM leaves behind. Game Boy games run as on a DMG, Color games as on a CGB
  (no CGB compatibility mode for DMG games).
- **Accuracy is measured with open-source test ROMs** (see Testing); keep
  them passing.
- **Storage:** IndexedDB for the ROM library, saved games and snapshots (too
  big for localStorage), localStorage for settings only.
- **License:** MIT.
- **No `SharedArrayBuffer`**: it needs COOP/COEP headers that plain static
  hosting can't set. Audio goes to the AudioWorklet with `postMessage`.
- **Mobile is a first-class target**: touch controls, responsive layout, safe
  areas. Check phone portrait and landscape when changing the UI.
- The UI is kept deliberately simple; the user fine-tunes it themselves.

## Hosting

Published with GitHub Pages from the root of `main` at
https://veniware.github.io/WebGB/ (no build or workflow; `.nojekyll` makes
Pages serve the files as-is). Every push to `main` goes live, so keep `main`
working. Keep all URLs relative: the site lives under `/WebGB/`.

## Commands

```sh
npm start                 # dev server at http://localhost:8080 (tools/serve.js, no deps)
npm test                  # node --test, runs tests/*.test.js
npm run fetch-test-roms   # downloads test ROMs into tests/roms/ (not committed)
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
  state.js              Save-state writer/reader with symmetric sync(s) methods
  gb/                   Game Boy / Game Boy Color core (see "Game Boy core")
    index.js            createCore(): CGB mode for Color ROMs
    gameboy.js          System: memory map, I/O registers, OAM DMA, HDMA, speed
                        switch, frame loop, save states; implements Core
    cpu.js              SM83 CPU, M-cycle accurate
    ppu.js              PPU: mode/STAT timing, line renderer, DMG and CGB
    apu.js              APU: 4 channels, frame sequencer, mixing, filtering
    timer.js            DIV/TIMA from the 16-bit system counter (falling edges)
    cartridge.js        Header parsing and mappers (ROM, MBC1/2/3/5, HuC1)
    rtc.js              MBC3 real-time clock (wall clock) and its save format
    joypad.js, serial.js
    palettes.js         DMG shades and CGB color conversion
    constants.js        Clock rate, frame size, interrupt bits
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
tools/fetch-test-roms.js  Downloads the test ROM collection into tests/roms/
tests/                  node:test tests (+ helpers.js for fake ROMs/zips, png.js
                        to compare screenshots)
  gb-core.test.js       Game Boy core unit tests (hand-assembled programs, mappers)
  gb-test-roms.test.js  Runs the downloaded test ROMs; lists known failures
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

### Game Boy core

- **Timing:** the CPU drives time. Every memory access or internal delay
  calls `GameBoy.tick()`, which advances the timer, PPU, serial port and DMA
  by one M-cycle (4 dots, or 2 in CGB double speed) *before* the access.
  Timing quirks of the PPU and DMA were tuned against the Mooneye tests;
  re-run them after touching `tick()`, the CPU or the PPU phases.
- **PPU:** a state machine of per-line phases (`Phase` in `ppu.js`) at
  4-dot precision: STAT mode, LY=LYC, interrupts and VRAM/OAM locks change at
  slightly different dots. Each line is rendered in one go when drawing ends,
  so mid-line register writes aren't shown. Frames go to a back buffer that
  is swapped in at VBlank.
- **APU:** lazy. `tick()` only adds to `apu.pending`; `catchUp()` runs the
  channels up to now before any APU register access, on each frame
  sequencer clock and at the end of `runFrame()`. Output is box-filtered to
  48 kHz, then high-pass filtered like the hardware's output capacitor.
- **Frames:** `runFrame()` runs until the next VBlank (or one frame's worth
  of time while the LCD is off), so frames stay in step with the display.
- **Save states:** each component has `sync(s)` (see `src/core/state.js`);
  add new fields there. Bump `GameBoy.version` when the format changes.
- **Battery saves** are the raw cartridge RAM; MBC3 clock carts append the
  48-byte RTC block used by VBA-M/BGB/mGBA. The RTC follows the wall clock
  (like the real cartridge, it keeps running while the game is closed), and
  its saved form doesn't change while it runs, so it doesn't trigger writes.
- **Not emulated:** CGB compatibility palettes for DMG games, mid-line PPU
  effects, the DMG's OAM corruption bug and wave-RAM access quirks, the
  infrared port, rumble, MBC6/MBC7/MMM01/HuC3/camera cartridges.

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

## Testing

- `tests/gb-core.test.js`: fast unit tests that need no ROMs.
- `tests/gb-test-roms.test.js`: Blargg's tests (serial or cartridge-RAM
  output), the Mooneye Test Suite (Fibonacci registers over serial),
  dmg-acid2 and cgb-acid2 (screenshot vs reference PNG). Skipped until
  `npm run fetch-test-roms` has downloaded them (the c-sp/game-boy-test-roms
  release). `KNOWN_FAILURES` lists the ones that don't pass yet, with reasons;
  remove entries as they get fixed, and don't add new ones to hide
  regressions.

## Conventions

- ES modules, 2-space indent, single quotes, semicolons, `camelCase`, classes
  in `PascalCase`. Private class members use `#fields`.
- Keep modules small and single-purpose; wire them together in `main.js`
  rather than importing across layers (e.g. cores never touch the DOM).
- No allocations in per-frame hot paths of cores (reuse typed arrays).
- Wrap localStorage access in try/catch; it can throw.
- Comments explain *why*, not *what*.
- Never commit ROMs (see `.gitignore`), test ROMs included: they are
  downloaded into `tests/roms/`.

## Roadmap

Done: Game Boy core (CPU, memory/MBCs, PPU, timer, APU, joypad) and Game Boy
Color support.

1. GBA core (needs a BIOS: user-supplied file or high-level emulation).
2. Game Boy extras: DMG palette choice, CGB color correction, CGB
   compatibility palettes for DMG games, rumble.
3. Memory viewer/editor (inspect and edit RAM, VRAM, OAM, I/O registers
   of the running game).
4. Input mapping: rebind keyboard keys and controller buttons from the UI
   (saved with the settings).
5. FPS counter toggled from the settings (the status bar shows a basic
   fps figure today): emulated fps, speed and time per frame, for
   performance work.
6. Renderer setting: Auto / WebGL / Canvas 2D, and a WebGPU renderer later
   (renderers are separate modules in `src/video/`).
7. Make it a PWA: web app manifest and service worker, so it installs to
   the home screen (fullscreen on iPhone) and works offline.
8. Possibly later: rewind, audio/video recording, full backup export/import
   of the library.
