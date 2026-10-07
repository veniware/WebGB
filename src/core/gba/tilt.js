// Games with an accelerometer on the cartridge (in the save memory area),
// by game code: Yoshi Topsy-Turvy, Koro Koro Puzzle.
export const TILT_GAMES = new Set(['KYG', 'KHP']);
// The reading when level, and its change per g (an estimate: like mGBA, we
// only know the center).
const CENTER = 0x3a0;
const PER_G = 0x100;

/**
 * Two-axis accelerometer at 0x0E008000-0x0E0085FF: writing 0x55 to 8000 then
 * 0xAA to 8100 samples it; 8200-8500 read X and Y (12 bits each, bit 7 of
 * 8300 flags a finished sample). After mGBA.
 */
export class TiltSensor {
    /** Input, in g. */
    x = 0;
    y = 0;

    constructor() {
        this.reset();
    }

    reset() {
        this.armed = false;
        this.sampleX = CENTER;
        this.sampleY = CENTER;
    }

    sync(s) {
        this.armed = s.bool(this.armed);
        this.sampleX = s.u16(this.sampleX);
        this.sampleY = s.u16(this.sampleY);
    }

    /** @param {number} address    Offset in the save memory area. */
    handles(address) {
        return address >= 0x8000 && address < 0x8600;
    }

    write(address, value) {
        if (address === 0x8000) this.armed = value === 0x55;
        else if (address === 0x8100 && value === 0xaa && this.armed) {
            this.armed = false;
            this.sampleX = reading(this.x);
            this.sampleY = reading(this.y);
        }
    }

    read(address) {
        switch (address) {
            case 0x8200: return this.sampleX & 0xff;
            case 0x8300: return ((this.sampleX >> 8) & 0xf) | 0x80;
            case 0x8400: return this.sampleY & 0xff;
            case 0x8500: return (this.sampleY >> 8) & 0xf;
            default: return 0xff;
        }
    }
}

function reading(g) {
    return Math.max(0, Math.min(0xfff, CENTER + Math.round(Math.max(-2, Math.min(2, g)) * PER_G)));
}
