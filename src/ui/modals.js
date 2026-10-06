/**
 * Shows dialogs modally. While any dialog is open the game is paused and
 * game input is off; it resumes when the last one closes, unless it was
 * paused before or the game changed in the meantime.
 *
 * @param {{ emulator: import('../app/emulator.js').Emulator, inputs: Array<{ enabled: boolean }> }} deps
 */
export function createModals({ emulator, inputs }) {
  let openCount = 0;
  let resumeCore = null;

  return {
    /** @param {HTMLDialogElement} dialog */
    show(dialog) {
      if (dialog.open) return;
      if (openCount++ === 0) {
        resumeCore = emulator.core && !emulator.paused ? emulator.core : null;
        emulator.setPaused(true);
        inputs.forEach((input) => (input.enabled = false));
      }
      dialog.addEventListener(
        'close',
        () => {
          if (--openCount > 0) return;
          inputs.forEach((input) => (input.enabled = true));
          if (resumeCore && emulator.core === resumeCore) emulator.setPaused(false);
        },
        { once: true },
      );
      dialog.showModal();
    },
  };
}
