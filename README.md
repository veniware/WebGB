# WebGB

A Game Boy / Game Boy Color / Game Boy Advance emulator written in plain
JavaScript. It runs entirely in the browser: no server-side processing, no
build step and no dependencies.

**Play it:** https://veniware.github.io/WebGB/

> **Status:** the frontend is in place (ROM loading, video filters, audio,
> keyboard/gamepad/touch input, speed control, saves and snapshots). The
> emulator cores are not implemented yet; loading a ROM currently starts a
> test core that exercises the frontend.

## Running

The app is static files, but browsers block ES modules and AudioWorklets on
`file://`, so serve the folder over HTTP:

```sh
npm start          # http://localhost:8080 (no dependencies needed)
npm test           # unit tests (Node 20+)
```

Any static host works too (Netlify, `python3 -m http.server`, ...). The live
version is published with GitHub Pages straight from the `main` branch.
Audio needs a secure context: `https://` or `localhost`.

## Features

- **ROM library:** ROMs you open or drop onto the page (`.gb`, `.gbc`,
  `.gba`, plain or zipped) are kept in the browser. Browse, play, export and
  delete them from the Library.
- **Saved games:** in-game saves are stored automatically, several per game.
  When you pick a game that has saved games or snapshots, you choose which one
  to continue (or start a new game). Saved games can be imported and exported
  as `.sav` files, compatible with other emulators; dropping a `.sav` onto the
  page imports it for the running game.
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
