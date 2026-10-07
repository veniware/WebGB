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
Suite, Mealybug, the acid2 tests, SameSuite, AGE, GBMicrotest and more) when
they have been downloaded to `tests/roms/`.

## Features

- **Game Boy and Game Boy Color:** CPU, timer, DMA and interrupts accurate
  to the M-cycle, graphics with mid-line effects, all four sound channels,
  CGB double speed and HDMA, and the original hardware's quirks (OAM bug,
  wave RAM). Passes Blargg's tests, dmg-acid2, cgb-acid2, the applicable
  Mooneye Test Suite and most of the Mealybug Tearoom tests.
- **Cartridges:** MBC1, MBC2, MBC3 (real-time clock), MBC5 (rumble), MBC6,
  MBC7 (tilt sensor: device tilt or I/J/K/L keys), MMM01, HuC1 and HuC3
  (infrared, clock), TAMA5 and the Pocket Camera (uses your webcam).
- **Colors:** Game Boy games can use the Game Boy Color's palettes (chosen
  per game as the GBC does, or any of its presets), the Super Game Boy's
  palettes or original-screen shades; optional GBC LCD color correction.
- **Super Game Boy:** games made for it get their colors, borders and
  multiplayer (player 2 on the keyboard or a second gamepad).
- **Link cable:** play two games linked side by side (stacked in portrait),
  e.g. to trade or battle; player 2 uses the keyboard or a second gamepad.
- **ROM library:** ROMs you open or drop onto the page (`.gb`, `.gbc`,
  `.gba`, plain or zipped) are kept in the browser. Browse, play, export and
  delete them from the Library.
- **Saved games:** in-game saves are stored automatically, several per game.
  When you pick a game that has saved games or snapshots, you choose which one
  to continue (or start a new game). Saved games can be imported and exported
  as `.sav` files, compatible with other emulators (including the MBC3
  clock); dropping a `.sav` onto the page imports it for the running game.
- **Snapshots:** save states that you can return to later. Saved games and
  snapshots show a screenshot from when they were made.
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
| Player 2 (link cable, SGB multiplayer) | W/A/S/D, H (A), G (B), Y (Start), T (Select) | Second gamepad |
| Tilt (MBC7 games) | I / J / K / L | Right stick          |

On touch screens the on-screen controls appear automatically.

## Project layout

See [AGENTS.md](AGENTS.md) for the architecture and conventions.

## License

MIT, see [LICENSE](LICENSE).
