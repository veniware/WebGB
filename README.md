# WebGB

**▶ [Play WebGB in your browser](https://veniware.github.io/WebGB/)**

A Game Boy / Game Boy Color / Game Boy Advance emulator written in plain
JavaScript. It runs entirely in the browser: no server-side processing, no
build step and no dependencies.

> **Status:** Game Boy and Game Boy Color games run. Game Boy Advance
> emulation is not implemented yet; GBA ROMs start a test core that only
> exercises the frontend.

## Running

Open **https://veniware.github.io/WebGB/** in a browser. Nothing to install:
the site is published with GitHub Pages straight from the `main` branch, and
your ROMs, saved games and snapshots stay in your browser's storage.

### Development

To work on the code, serve the folder locally (browsers block ES modules and
AudioWorklets on `file://`):

```sh
npm start                 # http://localhost:8080 (no dependencies needed)
npm test                  # tests (Node 20+)
npm run fetch-test-roms   # optional: download test ROMs for the accuracy tests
```

`npm test` also runs open-source test ROMs (Blargg's tests, the Mooneye Test
Suite, dmg-acid2, cgb-acid2) when they have been downloaded to `tests/roms/`.

## Features

- **Game Boy and Game Boy Color:** CPU, timer, DMA and interrupts accurate
  to the M-cycle, line-based graphics, all four sound channels, MBC1, MBC2,
  MBC3 (with its real-time clock), MBC5 and HuC1 cartridges, CGB double speed
  and HDMA. Passes Blargg's CPU, timing and sound tests, dmg-acid2, cgb-acid2
  and most of the Mooneye Test Suite.
- **ROM library:** ROMs you open or drop onto the page (`.gb`, `.gbc`,
  `.gba`, plain or zipped) are kept in the browser. Browse, play, export and
  delete them from the Library.
- **Saved games:** in-game saves are stored automatically, several per game.
  When you pick a game that has saved games or snapshots, you choose which one
  to continue (or start a new game). Saved games can be imported and exported
  as `.sav` files, compatible with other emulators (including the MBC3
  clock); dropping a `.sav` onto the page imports it for the running game.
- **Snapshots:** save states with thumbnails that you can return to later.
- **Video:** WebGL2 renderer with filters (Sharp, Nearest, Smooth, Scale2x)
  and an optional de-dither pass, zoom (Fit or 1×–6×) and fullscreen. Falls
  back to a 2D canvas without WebGL2.
- **Audio:** AudioWorklet output with dynamic rate control to avoid crackles.
- **Input:** keyboard, gamepads (Gamepad API) and on-screen touch controls.
- **Speed:** 1×–8×, plus hold-to-fast-forward.

ROMs, saved games and snapshots live in the browser's IndexedDB; settings use
localStorage. Clearing the site's data deletes them, so export saved games you
care about.

## Controls

| Action        | Keyboard       | Gamepad (standard layout) |
| ------------- | -------------- | ------------------------- |
| D-pad         | Arrow keys     | D-pad / left stick        |
| A / B         | X / Z          | Right / bottom face button |
| L / R         | A / S          | LB / RB                   |
| Start         | Enter          | Start                     |
| Select        | Right Shift, Backspace | Back / Select     |
| Fast-forward (hold) | Tab      | RT                        |
| Pause         | P              |                           |
| Fullscreen    | F              |                           |
| Take snapshot | F2             |                           |
| Load latest snapshot | F4      |                           |

On touch screens the on-screen controls appear automatically.

## Project layout

See [AGENTS.md](AGENTS.md) for the architecture and conventions.

## License

MIT, see [LICENSE](LICENSE).
