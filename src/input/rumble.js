/**
 * Rumble output for cartridges with a motor: vibrates gamepads that
 * support it and, on touch devices, the phone itself.
 */
export class Rumble {
    #level = 0;
    #lastPulse = 0;

    /** @param {{ gamepad?: { rumble: (strength: number, duration: number) => void } }} [deps] */
    constructor({ gamepad } = {}) {
        this.gamepad = gamepad;
        this.phone = typeof navigator !== "undefined" && "vibrate" in navigator &&
            typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
    }

    /** Called once per animation frame with the motor's strength (0-1). */
    set(level, now = performance.now()) {
        if (level < 0.05) {
            if (this.#level > 0) this.#stop();
            this.#level = 0;
            return;
        }
        // Effects are re-triggered while the motor keeps running.
        if (now - this.#lastPulse < 80 && Math.abs(level - this.#level) < 0.2) return;
        this.#level = level;
        this.#lastPulse = now;
        this.gamepad?.rumble(level, 120);
        if (this.phone && level > 0.3) navigator.vibrate(120);
    }

    #stop() {
        this.gamepad?.rumble(0, 0);
        if (this.phone) navigator.vibrate(0);
    }
}
