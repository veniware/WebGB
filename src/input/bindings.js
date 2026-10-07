import { Button } from "../core/buttons.js";
import { DEFAULT_HOTKEYS, DEFAULT_KEY_MAP } from "./keyboard.js";
import { DEFAULT_PAD_MAP, FAST_FORWARD_BUTTON, REWIND_BUTTON } from "./gamepad.js";

/**
 * What the user can bind: console buttons (keyboard and gamepad) and the
 * hotkeys (keyboard; fast-forward and rewind also on the gamepad). Bindings are kept as
 * { [action id]: [KeyboardEvent.code or gamepad button index, ...] }.
 */
export const ACTIONS = [
    { id: "UP", name: "Up", button: Button.UP },
    { id: "DOWN", name: "Down", button: Button.DOWN },
    { id: "LEFT", name: "Left", button: Button.LEFT },
    { id: "RIGHT", name: "Right", button: Button.RIGHT },
    { id: "A", name: "A", button: Button.A },
    { id: "B", name: "B", button: Button.B },
    { id: "L", name: "L", button: Button.L },
    { id: "R", name: "R", button: Button.R },
    { id: "START", name: "Start", button: Button.START },
    { id: "SELECT", name: "Select", button: Button.SELECT },
    { id: "fastForward", name: "Fast-forward (hold)", hotkey: true, pad: true },
    { id: "rewind", name: "Rewind (hold)", hotkey: true, pad: true },
    { id: "pause", name: "Pause", hotkey: true },
    { id: "fullscreen", name: "Fullscreen", hotkey: true },
    { id: "snapshot", name: "Take snapshot", hotkey: true },
    { id: "loadSnapshot", name: "Load latest snapshot", hotkey: true },
    { id: "record", name: "Start/stop recording", hotkey: true },
];

const BUTTON_ACTIONS = ACTIONS.filter((action) => action.button);

export function defaultKeyBindings() {
    const bindings = Object.fromEntries(ACTIONS.map((action) => [action.id, []]));
    for (const [code, button] of Object.entries(DEFAULT_KEY_MAP)) {
        bindings[BUTTON_ACTIONS.find((action) => action.button === button).id].push(code);
    }
    for (const [code, hotkey] of Object.entries(DEFAULT_HOTKEYS)) bindings[hotkey].push(code);
    return bindings;
}

export function defaultPadBindings() {
    const bindings = Object.fromEntries(ACTIONS.filter((a) => a.button || a.pad).map((action) => [action.id, []]));
    for (const [index, button] of DEFAULT_PAD_MAP) {
        bindings[BUTTON_ACTIONS.find((action) => action.button === button).id].push(index);
    }
    bindings.fastForward.push(FAST_FORWARD_BUTTON);
    bindings.rewind.push(REWIND_BUTTON);
    return bindings;
}

/** Saved bindings over the defaults (actions added later keep their defaults). */
export function withDefaults(saved, defaults) {
    const bindings = { ...defaults };
    for (const [id, values] of Object.entries(saved ?? {})) {
        if (id in bindings && Array.isArray(values)) bindings[id] = [...values];
    }
    return bindings;
}

/** Keyboard bindings as KeyboardInput's maps. */
export function keyboardMaps(bindings) {
    const keyMap = {};
    const hotkeys = {};
    for (const action of ACTIONS) {
        for (const code of bindings[action.id] ?? []) {
            if (action.button) keyMap[code] = (keyMap[code] ?? 0) | action.button;
            else hotkeys[code] = action.id;
        }
    }
    return { keyMap, hotkeys };
}

/** Gamepad bindings as GamepadInput's map and fast-forward and rewind buttons. */
export function gamepadMaps(bindings) {
    const map = [];
    for (const action of BUTTON_ACTIONS) {
        for (const index of bindings[action.id] ?? []) map.push([index, action.button]);
    }
    return { map, fastForward: bindings.fastForward ?? [], rewind: bindings.rewind ?? [] };
}

const KEY_NAMES = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Space: "Space", Enter: "Enter", Tab: "Tab",
    Backspace: "Backspace", Escape: "Esc", ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
    ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl", AltLeft: "Left Alt", AltRight: "Right Alt",
};

/** A readable name for a KeyboardEvent.code. */
export function keyName(code) {
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    return code.replace(/^Key|^Digit/, "").replace(/^Numpad(.+)/, "Num $1");
}

// Standard gamepad layout, by position (labels differ between brands).
const PAD_BUTTON_NAMES = [
    "Bottom button", "Right button", "Left button", "Top button", "LB / L1", "RB / R1", "LT / L2", "RT / R2",
    "Back / Select", "Start", "Left stick press", "Right stick press", "D-pad up", "D-pad down", "D-pad left",
    "D-pad right", "Home",
];

export function padButtonName(index) {
    return PAD_BUTTON_NAMES[index] ?? `Button ${index}`;
}
