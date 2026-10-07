import {
    ACTIONS, defaultKeyBindings, defaultPadBindings, keyName, padButtonName, withDefaults,
} from "../input/bindings.js";
import { h } from "./dom.js";

// Gives up waiting for a gamepad button after this long (ms).
const PAD_WAIT = 10_000;

/**
 * Controls dialog: each action's keyboard key and gamepad button. Click one,
 * then press the new key or button (Esc cancels, Delete clears).
 *
 * @param {{
 *     dialog: HTMLDialogElement,
 *     modals: ReturnType<typeof import('./modals.js').createModals>,
 *     settings: { keyBindings: object | null, padBindings: object | null },
 *     onChange: (keyBindings: object | null, padBindings: object | null) => void,
 * }} deps    onChange gets null for bindings back at their defaults.
 */
export function createControlsDialog({ dialog, modals, settings, onChange }) {
    const rows = dialog.querySelector("[data-rows]");
    let keys = withDefaults(settings.keyBindings, defaultKeyBindings());
    let pads = withDefaults(settings.padBindings, defaultPadBindings());
    // The capture in progress: { stop() }.
    let capture = null;

    function save() {
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        onChange(same(keys, defaultKeyBindings()) ? null : keys, same(pads, defaultPadBindings()) ? null : pads);
        render();
    }

    /** Binds `value` to the action, taking it away from any other. */
    function bind(bindings, id, value) {
        for (const other of Object.keys(bindings)) bindings[other] = bindings[other].filter((v) => v !== value);
        bindings[id] = [value];
    }

    function render() {
        rows.replaceChildren(...ACTIONS.map((action) => h("tr", {},
            h("th", { scope: "row", textContent: action.name }),
            h("td", {}, h("button", {
                type: "button",
                className: "binding",
                textContent: keys[action.id].map(keyName).join(" / ") || "—",
                onclick: (e) => captureKey(action, e.currentTarget),
            })),
            h("td", {}, action.button || action.pad
                ? h("button", {
                    type: "button",
                    className: "binding",
                    textContent: pads[action.id].map(padButtonName).join(" / ") || "—",
                    onclick: (e) => capturePad(action, e.currentTarget),
                })
                : null),
        )));
    }

    function captureKey(action, button) {
        capture?.stop();
        button.textContent = "Press a key…";
        const onKey = (e) => {
            e.preventDefault();
            e.stopPropagation();
            stop();
            if (e.code === "Delete") keys[action.id] = [];
            else if (e.code !== "Escape") bind(keys, action.id, e.code);
            save();
        };
        const stop = () => {
            window.removeEventListener("keydown", onKey, true);
            capture = null;
        };
        window.addEventListener("keydown", onKey, true);
        capture = { stop };
    }

    function capturePad(action, button) {
        capture?.stop();
        button.textContent = "Press a button…";
        const pressed = () => new Set((navigator.getGamepads?.() ?? []).flatMap((pad) =>
            pad ? pad.buttons.flatMap((b, i) => (b.pressed || b.value > 0.5 ? [i] : [])) : []));
        const held = pressed();
        const started = performance.now();
        let frame = 0;
        const poll = () => {
            const now = pressed();
            const index = [...now].find((i) => !held.has(i));
            if (index !== undefined) {
                stop();
                bind(pads, action.id, index);
                save();
            } else if (performance.now() - started > PAD_WAIT) {
                stop();
                render();
            } else {
                for (const i of held) if (!now.has(i)) held.delete(i);
                frame = requestAnimationFrame(poll);
            }
        };
        // Esc or Delete while waiting for the gamepad.
        const onKey = (e) => {
            if (e.code !== "Escape" && e.code !== "Delete") return;
            e.preventDefault();
            e.stopPropagation();
            stop();
            if (e.code === "Delete") {
                pads[action.id] = [];
                save();
            } else render();
        };
        const stop = () => {
            cancelAnimationFrame(frame);
            window.removeEventListener("keydown", onKey, true);
            capture = null;
        };
        window.addEventListener("keydown", onKey, true);
        frame = requestAnimationFrame(poll);
        capture = { stop };
    }

    // Esc during a capture cancels it, not the dialog.
    dialog.addEventListener("cancel", (e) => capture && e.preventDefault());
    dialog.addEventListener("close", () => capture?.stop());
    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-reset]").addEventListener("click", () => {
        capture?.stop();
        keys = defaultKeyBindings();
        pads = defaultPadBindings();
        save();
    });

    return {
        open() {
            render();
            modals.show(dialog);
        },
    };
}
