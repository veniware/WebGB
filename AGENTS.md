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
- **Cores:** Game Boy / Game Boy Color (`src/core/gb/`) and Game Boy Advance
  (`src/core/gba/`). The test core (`src/core/test/`) is only a fallback for
  systems without a core.
- **No boot ROMs or BIOS files** (they're copyrighted): cores start in the
  state the boot ROM leaves behind, and the GBA's BIOS calls are implemented
  in JavaScript (high-level emulation). Users can load their own GBA BIOS
  dump in the settings (kept in IndexedDB, never shipped). Game Boy games run as on a DMG, Color games
  as on a CGB (no CGB compatibility mode for DMG games).
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

It's a PWA (`manifest.webmanifest`, `icons/`, `sw.js`): installable, and it
starts offline. The service worker is network-first (a deploy is picked up as
soon as the page is online) and precaches the whole app on install, so its
`FILES` list must name every file; `tests/pwa.test.js` fails when a file is
missing from it.

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
tests, e.g. `webgb.emulator.core.getSaveData()`. Headless Chromium runs
WebGPU (and can show it on a canvas) with `--enable-unsafe-webgpu
--enable-features=Vulkan --use-vulkan=swiftshader --use-angle=swiftshader
--disable-vulkan-surface --enable-unsafe-swiftshader`; without the Vulkan
flags the GPU device is lost on the first frame.

## Architecture

```
index.html              Page shell: toolbar, stage, touch controls, status bar, dialogs
sw.js                   Service worker (offline); manifest.webmanifest, icons/: PWA
src/main.js             Composition root: builds the modules and wires them together
src/styles.css          All styles (touch layout under @media (pointer: coarse))
src/app/
  emulator.js           Host: owns the core, runs the rAF loop, speed, launching,
                        in-game saves, snapshots, link cable (player 2),
                        tilt/camera/rumble peripherals
  settings.js           Persisted user preferences (localStorage)
  emitter.js            Tiny event emitter
  rewind.js             Rewind history: save states, delta-compressed
  recorder.js           Video recording (MediaRecorder: screen canvas + sound)
src/core/
  interface.js          The Core contract (JSDoc) and CoreDescriptor
  registry.js           System -> core lookup; lazy-loads cores with import()
  buttons.js            Button bitmask shared by input and cores
  state.js              Save-state writer/reader with symmetric sync(s) methods
  memory.js             Helpers for memory regions (memory viewer)
  gb/                   Game Boy / Game Boy Color core (see "Game Boy core")
    index.js            createCore(): CGB mode for Color ROMs; createLinkedCore()
    gameboy.js          System: memory map, I/O registers, OAM DMA, HDMA, speed
                        switch, frame loop, save states; implements Core
    cpu.js              SM83 CPU, M-cycle accurate
    ppu.js              PPU: mode/STAT timing, line renderer, DMG and CGB
    fifo.js             Dot-by-dot pixel FIFO for lines changed during drawing
                        (adapted from SameBoy, MIT)
    apu.js              APU: 2 MHz channel timing ported from SameBoy (MIT),
                        DIV events, mixing, filtering
    channels.js         Simple channel models (the GBA's sound; reading old states)
    timer.js            DIV/TIMA from the 16-bit system counter (falling edges)
    cartridge.js        Header parsing, cartridge type table, createCartridge()
    mappers/            base.js; mbc.js (MBC1/2/3/5, HuC1); mbc6.js, mbc7.js
                        (tilt + EEPROM), mmm01.js, huc3.js, tama5.js, camera.js
    rtc.js              MBC3 real-time clock (wall clock) and its save format
    joypad.js
    serial.js           Serial port; `link` points at the other machine's port
    link.js             LinkedGameBoys: two machines on one cable, one Core
    memory.js           Memory regions: CPU view (through the bus), banks
    sgb.js              Super Game Boy: P1 packets, palettes/attributes, VRAM
                        transfers, border, multiplayer (after SameBoy, MIT)
    palettes.js         DMG shades, CGB boot ROM compatibility palettes for DMG
                        games, button-combo presets, CGB color (correction)
    constants.js        Clock rate, frame size, interrupt bits
  gba/                  Game Boy Advance core (see "GBA core")
    index.js            createCore()
    gba.js              System: I/O registers, interrupts, keypad, the event
                        loop (runFrame), saves, save states; implements Core
    cpu.js              ARM7TDMI: registers, modes, exceptions, pipeline
    idle.js             Idle-loop skipping (exact: whole passes up to the next event)
    arm.js, thumb.js    Instruction decode tables and handlers
    multiply-carry.js   The carry flag after multiplies, from the Booth
                        multiplier's internals (after zaydlang's
                        multiplication-algorithm, zlib license)
    bus.js              Memory map, wait states, prefetch buffer, open bus
    bios.js             HLE BIOS: built-in vectors/IRQ stub, SWIs in JS
    ppu.js              Line timing and a scanline renderer (all modes,
                        sprites a line ahead, windows, blending, mosaic)
    dma.js              Four channels; HBlank/VBlank/sound FIFO/immediate
    timers.js           Lazy counters, overflow events, cascade
    apu.js              Game Boy channels (from gb/channels.js) + DMA sound FIFOs
    sio.js              Serial port: unlinked as measured; linked multiplayer,
                        Normal (8/32-bit) and UART transfers with the partner
    link.js             LinkedGbas: two GBAs on one cable, one Core
    multiboot.js        Multiboot: the BIOS's receiving side (player 2 without
                        a cartridge) and SWI 0x25 MultiBoot
    backup.js           SRAM / Flash / EEPROM, detected from ID strings
    gpio.js             Cartridge GPIO: Seiko RTC (Pokémon, Boktai), solar
                        sensor (Boktai), gyro and rumble (WarioWare Twisted,
                        Drill Dozer)
    tilt.js             Accelerometer in the save area (Yoshi Topsy-Turvy)
    memory.js           Memory regions at their bus addresses
  test/test-core.js     Stand-in core: test pattern, button tones, a Start-press
                        counter in battery RAM, save states
src/video/
  display.js            Canvas sizing (zoom, devicePixelRatio), fullscreen
  webgl-renderer.js     WebGL2 renderer: effect passes, then one scaler program
  webgpu-renderer.js    WebGPU renderer: the same passes (starts asynchronously)
  canvas-renderer.js    2D-canvas fallback (no effects)
  filters.js            Scaler registry, effect shaders in GLSL and WGSL (add
                        filters here, in both languages)
  thumbnail.js          Frame -> PNG blob for snapshot thumbnails
src/audio/
  audio-output.js       AudioContext + worklet node, batching, autoplay unlock,
                        sound effects chain
  audio-processor.js    AudioWorklet processors (audio thread): player, pitch
  pitch-shifter.js      Pitch shifter DSP (two-tap delay line)
  resampler.js          Ring buffer + resampler + dynamic rate control
src/input/
  input-manager.js      Merges sources; cancels opposite D-pad directions
  keyboard.js           Key maps (player 1, player 2, tilt keys) and hotkeys
  bindings.js           User-changeable controls: actions, defaults, key names
  gamepad.js            Gamepad API polling; 2nd pad = player 2; rumble
  touch.js              On-screen controls (multi-touch, slide between buttons)
  motion.js             Device orientation -> tilt (MBC7)
  camera.js             Webcam -> grayscale frames (Game Boy Camera)
  rumble.js             Rumble on gamepads / phone vibration
src/rom/
  loader.js             File -> { name, data, info, key }; unzips
  detect.js             System detection from the cartridge header
  zip.js                Minimal zip reader (DecompressionStream)
src/storage/
  db.js                 IndexedDB open/upgrade and transaction helper
  roms.js               ROM library (metadata and bytes in separate stores)
  saves.js              Saved games (battery RAM), several per ROM
  snapshots.js          Snapshot metadata and states (separate stores)
  files.js              Other user files by name (the GBA BIOS)
  backup.js             Library backup/restore as a zip (manifest + files)
src/ui/
  ui.js                 Toolbar, opening files, drag-and-drop, status bar, hotkeys
  library-dialog.js     Library: play, export, delete ROMs; add ROMs
  game-dialog.js        Per game: new game, saved games (play/import/export/delete),
                        snapshots (load/take/delete), link cable
  link-dialog.js        Picks player 2's game and saved game, or no cartridge
                        (GBA multiboot: `emulator.link(null)`)
  settings-dialog.js    Settings (renderer, performance stats, Game Boy palette, ...)
  controls-dialog.js    Rebinding keyboard keys and gamepad buttons
  memory-dialog.js      Memory viewer/editor (hex pages of the core's regions,
                        live mode)
  memory-search.js      Cheat finder: search bytes by value, narrow by change
  bios-setting.js       GBA BIOS file in the settings (load, remove)
  modals.js             Shows dialogs; pauses the game and input while open
  dom.js                h() element helper, formatting, downloads, file picker
  files.js              Accepted file types and limits
src/util/crc32.js
src/util/zip-writer.js  Stored-only zip writer (backups)
tools/serve.js          Dev static server
tools/fetch-test-roms.js  Downloads the test ROM collection into tests/roms/
tests/                  node:test tests (+ helpers.js for fake ROMs/zips, png.js
                        to compare screenshots)
  gb-core.test.js       Game Boy core unit tests (hand-assembled programs, mappers)
  gb-test-roms.test.js  Blargg, Mooneye, Mealybug, acid2 test ROMs
  gb-test-suites.test.js  SameSuite, AGE, GBMicrotest, rtc3test, screenshot tests,
                        Mooneye (wilbertpol)
  test-roms.js          Shared helpers for the test ROM files
  known-failures.js     Test ROMs that don't pass yet, with reasons
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
`saveState`/`loadState`; optional members (peripherals, link, save
screenshots, `getMemoryRegions()` for the memory viewer) are documented in
the file. Memory regions read without side effects; writes either go
through the bus (CPU view, I/O) or into the arrays the hardware reads, and
count as save writes for battery memory so edits get stored.

To add a core: create `src/core/<name>/index.js` exporting
`createCore(rom, info)`, then register it in `src/core/registry.js`. Bump the
core's `version` whenever its `saveState()` format changes; snapshots from
other versions are refused unless the core lists them in `stateVersions`
(`loadState(state, version)` then converts them; the Game Boy reads version 4,
before the SameBoy APU, through `channels.js`).

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
- **APU** (`apu.js`, ported from SameBoy, DMG and CGB-E): a 2 MHz clock
  with the channels' start delays and 1 MHz phase (`lfDiv`), the noise
  LFSR clocked by a counter, envelope locks, the NRx2/NR10/NR43 write
  glitches. DIV's falling edges are the 512 Hz events (`divEvent`), rising
  edges reload envelopes (`divSecondaryEvent`). Lazy: `tick()` only adds to
  `apu.pending`; `catchUp()` runs up to now before APU register accesses,
  DIV events and the end of `runFrame()` (an M-cycle at a time around sweep
  and restart timing, as SameBoy does). Each channel's level is averaged
  over each 48 kHz sample, then high-pass filtered like the hardware's
  output capacitor. SameSuite's APU tests all pass on the CGB-E.
- **Frames:** `runFrame()` runs until the next VBlank (or one frame's worth
  of time while the LCD is off), so frames stay in step with the display.
- **Save states:** each component has `sync(s)` (see `src/core/state.js`);
  add new fields there. Bump `GameBoy.version` when the format changes.
- **Battery saves** are the raw cartridge RAM; MBC3 clock carts append the
  48-byte RTC block used by VBA-M/BGB/mGBA. The RTC follows the wall clock
  (like the real cartridge, it keeps running while the game is closed), and
  its saved form doesn't change while it runs, so it doesn't trigger writes.
- **Mid-line effects:** while the PPU draws, register writes that change the
  picture (LCDC, SCX/SCY, palettes, WX) are logged with their dot; lines with
  such writes are re-rendered dot by dot by `fifo.js`, the rest use the fast
  line renderer. Tuned against the Mealybug tests.
- **Boot:** no boot ROM is run (copyright); registers, I/O, DIV, the PPU
  position (DMG: line 153) and the DMG's VRAM logo are set to their
  post-boot values. DMG games on a CGB get the boot ROM's compatibility
  palette (or a user preset) from `palettes.js`.
- **Quirks emulated:** the DMG's OAM corruption bug (`oamBug*` in `ppu.js`,
  triggered by OAM accesses and 16-bit inc/dec in mode 2), DMG wave RAM
  access while channel 3 plays, APU "zombie mode" (NRx2 writes while
  playing), the serial clock running off the system counter, TIMA glitches
  from TAC writes, OAM DMA bus conflicts, power-on RAM noise (fixed seed),
  HALT sampling interrupts mid-M-cycle (the PPU ticks in two halves for
  this), the CGB speed switch pausing the CPU ~0x20008 cycles while DIV
  runs on.
- **MBC3 clock:** separate counters with the chip's rollover rules; follows
  the wall clock in the app, emulated time in rtc3test.
- **Peripherals:** optional Core members `getRumble()`, `wantsTilt`/`setTilt`,
  `wantsCamera`/`setCameraImage` are fed by the host from `src/input/`.
  HuC3 and TAMA5 clocks follow the wall clock like MBC3.
- **Link cable:** `LinkedGameBoys` runs both machines in 32-dot slices and
  swaps serial bytes and infrared light between them; screens side by side
  (stacked in portrait), sound mixed, player 2's buttons in bits 16+.
  Snapshots are disabled while linked. Player 2's saved game is written too.
- **Super Game Boy:** DMG games whose header asks for it run as an SGB
  (setting `sgb`, read at start): SGB clock (fps ~61.17), the PPU outputs
  shades 0-3 (`Ppu.outputShades`) and `Sgb.render()` colors them by the
  attribute map and draws the border (256x224; setting `sgbBorder`, live).
  `getScreenBuffer()` is always the bare 160x144 screen (link cable,
  thumbnails). No SGB BIOS: no default border, sound or SNES code commands.
- **Not emulated:** a CGB running DMG games (its compatibility mode); some
  mid-line window/sprite effects (see `KNOWN_FAILURES`).

### GBA core

- **Event loop:** `Gba.runFrame()` runs the CPU in a tight loop until the
  next event (`eventTime`: PPU line events, timer overflows, serial
  transfer, a pending interrupt or HALT); components schedule events with an
  `onSchedule` hook that can pull `eventTime` forward while the CPU runs.
  Accesses add their cycles to `bus.cycles` (the clock).
- **CPU:** the pipeline is real (`pipeA`/`pipeB`: the two opcodes fetched
  ahead), so self-modifying code behaves (the Classic NES Series checks it).
  Each step's fetch stands for the hardware's prefetch two opcodes ahead; a
  jump refills (2S + 1N); after a data access the fetch is non-sequential.
  Multiplies with S (and Thumb MUL) set C as the Booth multiplier leaves it
  (`multiply-carry.js`, checked against the original C on 1.2M inputs).
- **Idle loops** (`idle.js`): at each short backward branch (`cpu.onLoop`
  hook) the CPU is compared with the previous pass of the same loop. A pass
  with no writes (`bus.writes`), no reads of what changes on its own
  (`bus.volatileReads`: timers, sound registers, EEPROM), no event in
  between (`gba.eventCount`) and the same registers and flags leaves the
  machine as it found it, so whole passes are skipped up to the next event
  (`bus.skip`). The timing stays exact: states are byte-identical with
  skipping on and off (tested), and mGBA's suite gives the same results.
  Typically 70-97% of cycles are skipped while games wait. Anything new
  that changes without an event must count as a volatile read.
- **Bus timing:** WAITCNT wait states, forced non-sequential accesses at
  128 KB ROM boundaries, and a prefetch buffer worked out lazily from the
  time since the last fetch (cartridge data accesses, by the CPU or DMA,
  stop it; an opcode fetch one cycle from done finishes first).
- **DMA:** a transfer runs in one go (the CPU waits). An immediate one
  starts 2 cycles after the enabling write: the CPU runs on until its next
  bus access (`bus.dmaDue`) or the next event. From the cartridge to the
  cartridge, the first write is sequential. A transfer's last value stays
  on the bus (open-bus reads) until the CPU's next opcode fetch.
- **Interrupts** reach the CPU a few cycles after the request
  (`IRQ_DELAY`, `UNMASK_DELAY`); timer reads lag a little (`READ_DELAY`);
  HBlank starts at cycle 1008. These were tuned against mGBA's test suite.
- **BIOS (HLE):** `bios.js` builds a small BIOS image (vectors, the IRQ
  dispatcher that calls the game's handler) and implements the SWIs in JS,
  including the BIOS's side effects on registers and its cycle counts.
  IntrWait halts and re-runs the SWI after each interrupt.
- **BIOS file** (optional, `gbaBios` core option): replaces the built-in
  image and the HLE SWIs; the game starts directly (`bootState`) unless
  `gbaBiosIntro`. Its snapshots use another magic ("WGBB") and don't load
  into a core without the file, or the other way round (the CPU may be
  inside BIOS code). Tested with the open-source Cult-of-GBA BIOS (fails
  only jsmolka's bios.gba checks for official BIOS opcodes).
- **PPU:** each line is rendered at HBlank with the registers of that moment;
  sprites for a line are drawn during the line before (OAM changes show one
  line later, palette changes at once); a BG enabled mid-frame shows from the
  third line start after; windows open/close on their top/bottom lines.
- **Sound:** the Game Boy channel classes from `gb/channels.js` on a quarter clock,
  mixed with the FIFOs like the hardware (10 bits around SOUNDBIAS); FIFO
  samples are played on timer overflows and refilled by DMA 1/2.
- **Saves:** the backup type comes from the SDK's ID string in the ROM. The
  cartridge clock (by game code) follows the wall clock; if the game set it,
  a 16-byte block ("RTC1", status, offset) follows the save memory.
- **Cartridge sensors** (by game code, wiring after mGBA): the solar sensor
  reads the `gbaSunlight` setting (0-10); the gyro turns with the host's
  tilt x, the accelerometer gets tilt x/y (`wantsTilt`, so phones use the
  motion sensor); the rumble motor's share of on-time feeds `getRumble()`.
  Their state is only in the snapshots of those games (the format of other
  games' snapshots didn't change). The accelerometer's scale is a guess.
- **Link cable** (`link.js`, `sio.js`): `LinkedGbas` runs both machines
  in turn, 256 cycles at a time (`Gba.beginFrame`/`runUntil`/`endFrame`),
  each on its own clock; `sio.offset` converts times between them. Player 1
  is the parent. Multiplayer: the parent's start runs the transfer on both
  (2-player times from mGBA), SIOMULTI0-3 get both words and 0xFFFF, IDs
  are set. Normal: the internal-clock side swaps words with a partner that
  waits (external clock, started); SI shows the partner's SO. UART: bytes
  at the baud rate into the partner's receive buffer (FIFO 4 or 1). A side
  that is behind finishes its old transfer before a new one and doesn't
  look ready meanwhile. The unlinked port behaves exactly as before (the
  mGBA suite's SIO tests). Linked machines' states have extra SIO fields
  (only while linked; the host keeps no linked states). Tested with
  register-level unit tests and a two-GBA test program built with
  devkitARM's crt0 + libgba (100 multiplayer and 100 Normal-mode transfers
  each way, IRQ-driven, back to back). A multiplayer start written while
  unplugged stays busy; plugging the cable in (`Sio.plugged`) lets the
  parent's go ahead.
- **Multiboot** (`multiboot.js`): player 2 can be a GBA without a cartridge
  (`cartless`: empty ROM, no saves). With the built-in BIOS it runs no code
  while it waits (`Gba.stall`): `MultibootClient` answers the parent's
  multiplayer transfers (`sio.onMulti`) like the BIOS (handshake, header,
  palette, then the encrypted program word by word and the CRC), then
  starts the program at 0x020000C0 with the boot mode and client number in
  its header. A game that calls SWI 0x25 after the handshake gets the
  program copied over instead, and its BIOS stays busy (`stall`) as long
  as the transfer would take. With a BIOS file, that BIOS does both sides.
  Multiplayer mode only (no Normal-mode multiboot); the client's progress
  isn't in save states (the host keeps no linked states). Tested with
  unit tests and gba-link-connection's sender (MIT), sync (SWI 0x25) and
  async (the game sends everything), linked before or after it started.
- **Not emulated:** JOY Bus, the BIOS sound driver calls, mid-line register
  changes.

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
- Both keep a **thumbnail** (PNG): snapshots the screen when taken, saved
  games the screen when the game started writing the save (cores report
  writes with `getSaveWrites()`; the host screenshots the first frame after
  one, `Emulator.#watchSaves`).
- Deleting a ROM deletes its saved games and snapshots.
- Exported saved games are raw `.sav` files, compatible with other emulators.
- **Backup** (Library → Back up…): one zip with `webgb-backup.json` (ROM,
  saved game and snapshot metadata, settings, `format: 1`) and the files it
  names. Restoring adds what's missing (ROMs by key, saved games by romKey +
  created + name, snapshots by romKey + created), remaps snapshot `saveId`s,
  and offers to take the settings too (page reload). Bump `FORMAT` in
  `backup.js` when the manifest changes, and keep reading older formats.

### Identities and storage

- ROM key: `<system>-<crc32>-<size>` (from `loader.js`). Library entries,
  saved games and snapshots are keyed by it.
- IndexedDB `webgb`, version 2: `roms` (metadata, keyPath `key`), `romData`
  (`key` -> bytes), `saves` (autoIncrement `id`, index `romKey`), `snapshots`
  (metadata, autoIncrement `id`, index `romKey`), `snapshotStates` (`id` ->
  state bytes), `files` (keyPath `name`: other user files, e.g. `gba-bios`). Schema changes go in `db.js` `onupgradeneeded`, keyed on
  `event.oldVersion`, and bump `DB_VERSION`.
- In-game saves are written when they change (checked every 2 s, on tab hide
  and on pagehide).

### Video and sound effects

- **Video** (WebGL and WebGPU): a new frame goes through passes at the
  console's resolution, LCD ghosting (blends with the previous output,
  ping-pong render targets, advances only on new frames), then one pass for
  de-dither / sharpen / outlines; the scaler (`FILTERS`, e.g. "Smooth edges
  (xBR)") draws the result at screen size. Redraws without a new frame reuse
  the passes' output. Every scaler and effect exists in GLSL (`main`) and
  WGSL (`wgsl`); the two renderers draw the same pixels (checked in the
  browser, apart from rounding at pixel edges). Derivatives (`fwidth`) are
  taken up front: WGSL only allows them in uniform control flow.
- **Renderers** (setting `renderer`): 'auto' is WebGL2, or the 2D canvas
  without it; 'webgpu' is opt-in. `Display.setRenderer()` swaps in a fresh
  canvas (a canvas keeps its first context kind) and destroys the old
  renderer. WebGPU starts asynchronously: WebGL draws until it is ready,
  stays if WebGPU isn't available (`setRenderer`/`display.ready` resolve
  false and the UI says so), and takes over again if the GPU device is lost.
  Renderers expose `name`, `supportsShaders` and optional `destroy()`.
- **Sound:** emulator worklet -> pitch shifter (worklet, when not 0) ->
  high pass -> low pass -> bass boost (BiquadFilters) -> echo (delay with
  feedback, dry + wet) -> mono (1-channel gain) -> volume.
  `AudioOutput.setEffects()` rebuilds the chain; settings `audioPitch`,
  `audioLowpass`, `audioHighpass`, `audioBass`, `audioEcho`, `audioMono`.

### Rewind

Every 6 emulated frames the host pushes `core.saveState()` into a
`RewindBuffer` (groups of 20: one full state, then the runs of bytes that
differ from it; ~24 MB, oldest groups dropped). Holding the rewind input
(R, left trigger, touch "Back") pops 30 states a second (3x speed), loading
each and running one frame for its picture. The history is cleared wherever
the game jumps (reset, snapshot load, link, new game) and is off while two
games are linked. Setting `rewind`.

### Recording

Settings → Tools → Record video (or F9): `Recorder` records
`display.canvas.captureStream()` (the screen as drawn, filters included)
plus `AudioOutput.captureStream()` (what plays, after the volume) with
MediaRecorder, WebM (VP9/Opus) or MP4 on Safari, and downloads the file on
stop. Switching renderer stops it (the canvas is replaced).

### Input timing

Inputs report buttons pressed since the last poll even if already released,
and the host ORs input across animation frames that run no emulated frame,
so short taps are never lost.

## Testing

- `tests/gb-core.test.js`: fast unit tests that need no ROMs.
- `tests/gb-test-roms.test.js`: Blargg's tests (serial or cartridge-RAM
  output), the Mooneye Test Suite (Fibonacci registers over serial),
  Mealybug, dmg-acid2 and cgb-acid2 (screenshot vs reference PNG).
- `tests/gb-test-suites.test.js`: SameSuite (CGB), AGE, GBMicrotest,
  rtc3test (on emulated time), Bully, Strikethrough, TurtleTests,
  scribbltests, little-things-gb, mbc3-tester, cgb-acid-hell, wilbertpol's
  Mooneye. Each suite's pass criteria follow the c-sp collection's notes.
- `tests/gba-core.test.js`: GBA unit tests (hand-assembled programs, BIOS
  calls, pipeline, open bus, timers, sound, clock, save states).
- `tests/gba-test-roms.test.js`: jsmolka's gba-tests (r12 = 0 when passed).
- mGBA's test suite isn't run by `npm test` (it isn't in the downloaded
  collection; mGBA's own build is at
  https://s3.amazonaws.com/mgba/suite-latest.zip). Current results: memory
  1552/1552, I/O read 130/130, timing 1984/2020 (prefetch buffer meeting
  DMA), timer count-up 816/936
  (back-to-back interrupts), timer IRQ 90/90, shifter, carry, multiply long
  and BIOS math all, DMA 1244/1244, SIO all, misc 4/12, video tests all but
  sub-line glitches. A build from source with a newer GCC times its C
  functions differently ("C loop", the IRQ handlers).
- `RUN_KNOWN_FAILURES=1 npm test` runs the known failures too, to find the
  ones that pass now.
- The ROMs are skipped until `npm run fetch-test-roms` has downloaded them
  (the c-sp/game-boy-test-roms release and jsmolka/gba-tests). `tests/known-failures.js` lists
  the ones that don't pass yet, with reasons (mostly PPU and interrupt timing
  within an M-cycle); remove entries as they get fixed, and don't add
  new ones to hide regressions.

## Conventions

- ES modules, 4-space indent, double quotes (single quotes only around
  strings that contain double quotes), semicolons, `camelCase`, classes
  in `PascalCase`. Private class members use `#fields`.
- Keep modules small and single-purpose; wire them together in `main.js`
  rather than importing across layers (e.g. cores never touch the DOM).
- No allocations in per-frame hot paths of cores (reuse typed arrays).
- Wrap localStorage access in try/catch; it can throw.
- Comments explain *why*, not *what*.
- Never commit ROMs (see `.gitignore`), test ROMs included: they are
  downloaded into `tests/roms/`.
- Commit messages have no trailers (no Co-Authored-By or Claude-Session
  lines).

## Roadmap

Done: Game Boy and Game Boy Color (with palettes, color correction, Super
Game Boy, rare cartridges, rumble, link cable), the Game Boy Advance core
(with its cartridge sensors and an optional BIOS file), input mapping,
performance stats, the renderer setting, the PWA, video effects and scalers
(ghosting, sharpen, outlines, xBR, LCD grid, CRT), sound effects (pitch,
low/high pass, bass, echo, mono), the memory viewer/editor with cheat search
(Settings → Tools), rewind, library backup/restore, video recording, a
WebGPU renderer, GBA idle-loop skipping, the GBA link cable and multiboot.

Not done yet:

1. More video filters (HQx, NTSC, ...; `src/video/filters.js`) and sound
   effects (`AudioOutput.setEffects`).
