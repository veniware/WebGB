import { Cartridge } from "./base.js";

export const SENSOR_WIDTH = 128;
export const SENSOR_HEIGHT = 120; // 112 used lines + 4 above and below
const IMAGE_HEIGHT = 112;
const EDGE_RATIOS = [0.5, 0.75, 1, 1.25, 2, 3, 4, 5];

/**
 * Game Boy Camera / Pocket Camera: MBC3-like banking, 128 KiB of RAM and
 * the M64282FP sensor, whose registers appear in RAM banks 0x10+. A capture
 * runs the host's grayscale image (setImage) through the sensor's edge
 * filter and the cartridge's 4x4 dithering matrix into tiles at A100.
 * Based on Antonio Niño Díaz's research in Pan Docs.
 */
export class Camera extends Cartridge {
    constructor(options) {
        super({ ...options, ramSize: 0x20000, battery: true });
        this.registers = new Uint8Array(0x36);
        // Latest webcam frame, 8-bit grayscale; a gradient until the host sends one.
        this.image = new Uint8Array(SENSOR_WIDTH * SENSOR_HEIGHT);
        for (let y = 0; y < SENSOR_HEIGHT; y++) {
            for (let x = 0; x < SENSOR_WIDTH; x++) this.image[y * SENSOR_WIDTH + x] = ((x + y) * 255) / (SENSOR_WIDTH + SENSOR_HEIGHT);
        }
        this.sensor = new Int32Array(SENSOR_WIDTH * SENSOR_HEIGHT);
        this.filtered = new Int32Array(SENSOR_WIDTH * SENSOR_HEIGHT);
    }

    reset() {
        super.reset();
        this.registers?.fill(0);
        this.ramBank = 0;
        // CPU cycles until the running capture finishes.
        this.captureCycles = 0;
        this.ticking = false;
    }

    sync(s) {
        super.sync(s);
        s.bytes(this.registers);
        this.ramBank = s.u8(this.ramBank);
        this.captureCycles = s.i32(this.captureCycles);
        this.ticking = this.captureCycles > 0;
    }

    /** @param {Uint8Array} pixels SENSOR_WIDTH x SENSOR_HEIGHT grayscale */
    setImage(pixels) {
        this.image.set(pixels.subarray(0, this.image.length));
    }

    writeRom(addr, value) {
        if (addr < 0x2000) this.ramEnabled = (value & 0x0f) === 0x0a;
        else if (addr < 0x4000) this.romOffset1 = ((value & 0x3f) & this.romMask) * 0x4000;
        else if (addr < 0x6000) {
            this.ramBank = value;
            this.ramOffset = (value & 0x0f) * 0x2000;
        }
    }

    readRam(addr) {
        if (this.ramBank & 0x10) {
            // Only A000 (capture status) reads back.
            return (addr & 0x7f) === 0 ? this.registers[0] & 7 : 0;
        }
        if (this.captureCycles > 0) return 0;
        return this.ram[this.ramOffset + (addr & 0x1fff)];
    }

    writeRam(addr, value) {
        if (this.ramBank & 0x10) {
            const register = addr & 0x7f;
            if (register === 0) {
                const start = value & 1 && !(this.registers[0] & 1);
                this.registers[0] = value & 7;
                if (start) this.#capture();
                if (!(value & 1)) this.captureCycles = 0;
                this.ticking = this.captureCycles > 0;
            } else if (register < 0x36) {
                this.registers[register] = value;
            }
            return;
        }
        if (this.ramEnabled && this.captureCycles <= 0) this.ram[this.ramOffset + (addr & 0x1fff)] = value;
    }

    /** Counts down a running capture (CPU cycles). */
    tick(cycles) {
        this.captureCycles -= cycles;
        if (this.captureCycles > 0) return;
        this.captureCycles = 0;
        this.registers[0] &= ~1;
        this.ticking = false;
    }

    #capture() {
        const regs = this.registers;
        const nBit = (regs[1] >> 7) & 1;
        const vh = (regs[1] >> 5) & 3;
        const exposure = (regs[2] << 8) | regs[3];
        const alpha = EDGE_RATIOS[(regs[4] >> 4) & 7];
        const e3 = (regs[4] >> 7) & 1;
        const invert = (regs[4] >> 3) & 1;
        let plus = 0;
        let minus = 0;
        switch ((regs[0] >> 1) & 3) {
            case 0: minus = 1; break;
            case 1: plus = 1; break;
            default: plus = 1; minus = 2;
        }
        this.captureCycles = 4 * (32446 + (nBit ? 0 : 512) + 16 * exposure);

        // Sensor: exposure, then signed around the reference level.
        const w = SENSOR_WIDTH;
        const h = SENSOR_HEIGHT;
        const sensor = this.sensor;
        const temp = this.filtered;
        for (let i = 0; i < w * h; i++) {
            let value = Math.floor((this.image[i] * exposure) / 0x300);
            value = 128 + Math.floor((value - 128) / 8);
            value = Math.max(0, Math.min(255, value));
            if (invert) value = 255 - value;
            sensor[i] = value - 128;
        }
        const at = (x, y) => sensor[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
        const mode = (nBit << 3) | (vh << 1) | e3;
        if (mode === 0x0 || mode === 0x2) {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const px = at(x, y);
                    temp[y * w + x] = mode === 0x2 ? Math.max(0, Math.min(255, px + (2 * px - at(x - 1, y) - at(x + 1, y)) * alpha)) : px;
                }
            }
            // 1-D filtering against the pixel below.
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const px = temp[y * w + x];
                    const below = temp[Math.min(h - 1, y + 1) * w + x];
                    let value = 0;
                    if (plus & 1) value += px;
                    if (plus & 2) value += below;
                    if (minus & 1) value -= px;
                    if (minus & 2) value -= below;
                    sensor[y * w + x] = Math.max(-128, Math.min(127, value));
                }
            }
        } else if (mode === 0xe) {
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const px = at(x, y);
                    const edges = 4 * px - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
                    temp[y * w + x] = Math.max(-128, Math.min(127, px + edges * alpha));
                }
            }
            sensor.set(temp);
        } else if (mode === 0x1) {
            sensor.fill(0);
        }

        // Controller: 4x4 dithering/contrast matrix to 2-bit pixels, written as tiles at A100.
        const tiles = this.ram.subarray(0x100, 0x100 + 16 * 14 * 16);
        tiles.fill(0);
        for (let y = 0; y < IMAGE_HEIGHT; y++) {
            for (let x = 0; x < w; x++) {
                const value = sensor[(y + 4) * w + x] + 128;
                const base = 6 + ((y & 3) * 4 + (x & 3)) * 3;
                let shade = 3;
                if (value >= regs[base + 2]) shade = 0;
                else if (value >= regs[base + 1]) shade = 1;
                else if (value >= regs[base]) shade = 2;
                const tile = ((y >> 3) * 16 + (x >> 3)) * 16 + (y & 7) * 2;
                const bit = 0x80 >> (x & 7);
                if (shade & 1) tiles[tile] |= bit;
                if (shade & 2) tiles[tile + 1] |= bit;
            }
        }
    }
}
