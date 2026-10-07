import { h } from "./dom.js";

// Choices for select settings: [value, label] or [group label, choices].
const CHOICES = {
    renderer: [
        ["auto", "Automatic"],
        ["webgpu", "WebGPU"],
        ["webgl", "WebGL"],
        ["canvas", "2D canvas"],
    ],
    audioPitch: Array.from({ length: 25 }, (_, i) => {
        const semitones = i - 12;
        const size = Math.abs(semitones);
        const sign = semitones > 0 ? "+" : "−";
        return [semitones, semitones ? `${sign}${size} semitone${size > 1 ? "s" : ""}${size === 12 ? " (an octave)" : ""}` : "Normal"];
    }),
    audioLowpass: [[0, "Off"], [8000, "8 kHz"], [4000, "4 kHz"], [2000, "2 kHz"], [1000, "1 kHz"]],
    audioHighpass: [[0, "Off"], [100, "100 Hz"], [300, "300 Hz"], [1000, "1 kHz"]],
    gbaSunlight: Array.from({ length: 11 }, (_, level) =>
        [level, level ? `Level ${level}${level === 10 ? " (full sun)" : ""}` : "None (indoors)"]),
    audioBass: [[0, "Off"], [6, "+6 dB"], [12, "+12 dB"]],
    audioEcho: [["off", "Off"], ["room", "Room"], ["hall", "Hall"]],
    gbPalette: [
        ["auto", "Automatic"],
        ["gbc", "As on a Game Boy Color"],
        ["Original screen", [
            ["green", "Green"],
            ["classic", "Classic green"],
            ["pocket", "Game Boy Pocket"],
            ["gray", "Gray"],
        ]],
        ["Game Boy Color palettes", [
            ["gbc-brown", "Brown"],
            ["gbc-red", "Red"],
            ["gbc-dark-brown", "Dark brown"],
            ["gbc-blue", "Blue"],
            ["gbc-dark-blue", "Dark blue"],
            ["gbc-grayscale", "Grayscale"],
            ["gbc-pastel", "Pastel"],
            ["gbc-orange", "Orange"],
            ["gbc-yellow", "Yellow"],
            ["gbc-green", "Green"],
            ["gbc-dark-green", "Dark green"],
            ["gbc-inverted", "Inverted"],
        ]],
        ["Super Game Boy palettes", ["1", "2", "3", "4"].flatMap((group) =>
            [..."ABCDEFGH"].map((letter) => [`sgb-${group}-${letter}`, `${group}-${letter}`]))],
    ],
};

/**
 * Settings dialog. Controls with `data-setting="<key>"` edit that setting;
 * every change is saved and reported through onChange.
 *
 * @param {{
 *     dialog: HTMLDialogElement,
 *     modals: ReturnType<typeof import('./modals.js').createModals>,
 *     settings: object,
 *     onChange: (key: string, value: unknown) => void,
 * }} deps
 */
export function createSettingsDialog({ dialog, modals, settings, onChange }) {
    const controls = [...dialog.querySelectorAll("[data-setting]")];

    for (const control of controls) {
        const key = control.dataset.setting;
        if (control.tagName === "SELECT") control.append(...options(CHOICES[key] ?? []));
        control.addEventListener("change", () => {
            const value = control.type === "checkbox" ? control.checked
                : typeof settings[key] === "number" ? Number(control.value) : control.value;
            onChange(key, value);
        });
    }

    function render() {
        for (const control of controls) {
            const value = settings[control.dataset.setting];
            if (control.type === "checkbox") control.checked = Boolean(value);
            else control.value = String(value);
        }
    }

    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

    return {
        open() {
            render();
            modals.show(dialog);
        },
    };
}

function options(choices) {
    return choices.map(([value, label]) =>
        Array.isArray(label) ? h("optgroup", { label: value }, options(label)) : new Option(label, value));
}
