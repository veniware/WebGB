/**
 * Shows dialogs modally. While any dialog is open the game is paused and
 * game input is off; it resumes when the last one closes, unless it was
 * paused before or the game changed in the meantime.
 *
 * @param {{ emulator: import('../app/emulator.js').Emulator, inputs: Array<{ enabled: boolean }> }} deps
 */
export function createModals({ emulator, inputs }) {
    let openCount = 0;
    // The game (not the core: linking swaps the core of the same game).
    let resumeRom = null;

    return {
        /** @param {HTMLDialogElement} dialog */
        show(dialog) {
            if (dialog.open) return;
            if (openCount++ === 0) {
                resumeRom = emulator.core && !emulator.paused ? emulator.rom : null;
                emulator.setPaused(true);
                inputs.forEach((input) => (input.enabled = false));
            }
            dialog.addEventListener(
                "close",
                () => {
                    if (--openCount > 0) return;
                    inputs.forEach((input) => (input.enabled = true));
                    if (resumeRom && emulator.rom === resumeRom) emulator.setPaused(false);
                },
                { once: true },
            );
            dialog.showModal();
        },
    };
}
