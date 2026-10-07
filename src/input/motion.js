// Degrees from the resting position for a full 1 g reading.
const FULL_TILT = 45;

/**
 * Device tilt (phones, tablets) as an input source for tilt-sensor
 * cartridges. Only listens while active; the orientation when activated is
 * taken as level. iOS asks for permission, which needs a tap.
 */
export class MotionInput {
    #active = false;
    #rest = null;
    #tilt = { x: 0, y: 0 };
    #listening = false;

    /** @param {{ onNeedsPermission?: () => void }} [options] */
    constructor({ onNeedsPermission = () => {} } = {}) {
        this.onNeedsPermission = onNeedsPermission;
        this.handle = (e) => this.#orientation(e);
    }

    get available() {
        return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
    }

    setActive(active) {
        this.#active = active;
        this.#rest = null;
        this.#tilt = { x: 0, y: 0 };
        if (active) this.#listen();
    }

    /** Call from a user gesture (tap) when permission is needed. */
    async requestPermission() {
        const request = window.DeviceOrientationEvent?.requestPermission;
        if (!request) return true;
        try {
            return (await request.call(window.DeviceOrientationEvent)) === 'granted';
        } catch {
            return false;
        }
    }

    poll() {
        return this.#active
            ? { buttons: 0, fastForward: false, tiltX: this.#tilt.x, tiltY: this.#tilt.y }
            : { buttons: 0, fastForward: false };
    }

    #listen() {
        if (this.#listening || !this.available) return;
        if (typeof window.DeviceOrientationEvent.requestPermission === 'function') {
            // iOS: only after a tap.
            this.onNeedsPermission();
        }
        window.addEventListener('deviceorientation', this.handle);
        this.#listening = true;
    }

    #orientation(e) {
        if (!this.#active || e.beta === null || e.gamma === null) return;
        // Map device axes to the screen as it is currently rotated.
        const angle = screen.orientation?.angle ?? window.orientation ?? 0;
        let x = e.gamma;
        let y = e.beta;
        if (angle === 90) [x, y] = [e.beta, -e.gamma];
        else if (angle === -90 || angle === 270) [x, y] = [-e.beta, e.gamma];
        else if (angle === 180) [x, y] = [-e.gamma, -e.beta];
        this.#rest ??= { x, y };
        const g = (degrees) => Math.max(-1.5, Math.min(1.5, degrees / FULL_TILT));
        this.#tilt = { x: g(x - this.#rest.x), y: g(y - this.#rest.y) };
    }
}
