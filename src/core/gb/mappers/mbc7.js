import { Cartridge } from './base.js';

// Accelerometer readings: centered at 0x81D0, about 0x70 per g.
const CENTER = 0x81d0;
const ONE_G = 0x70;

/**
 * MBC7 (Kirby Tilt 'n' Tumble, Command Master): a 2-axis accelerometer and
 * a 256-byte 93LC56 EEPROM driven bit by bit through A080. The EEPROM is
 * the saved game. Based on Pan Docs and SameBoy (MIT).
 */
export class Mbc7 extends Cartridge {
    constructor(options) {
        super({ ...options, ramSize: 256, battery: true });
        this.ram.fill(0xff);
        // Tilt in g, set by the host: x positive = right, y positive = down.
        this.tiltX = 0;
        this.tiltY = 0;
    }

    reset() {
        super.reset();
        this.romBank = 1;
        this.ramEnabled2 = false;
        this.latchReady = false;
        this.latchX = 0x8000;
        this.latchY = 0x8000;
        this.cs = false;
        this.clk = false;
        this.di = false;
        this.do = true;
        this.command = 0;
        this.argumentBits = 0;
        this.readBits = 0xffff;
        this.writeEnabled = false;
        this.romOffset1 = 0x4000;
    }

    sync(s) {
        super.sync(s);
        this.romBank = s.u8(this.romBank);
        for (const flag of ['ramEnabled2', 'latchReady', 'cs', 'clk', 'di', 'do', 'writeEnabled']) this[flag] = s.bool(this[flag]);
        for (const field of ['latchX', 'latchY', 'command', 'argumentBits', 'readBits']) this[field] = s.u16(this[field]);
    }

    writeRom(addr, value) {
        if (addr < 0x2000) this.ramEnabled = value === 0x0a;
        else if (addr < 0x4000) this.romOffset1 = ((value & 0x7f) & this.romMask) * 0x4000;
        else if (addr < 0x6000) this.ramEnabled2 = value === 0x40;
    }

    readRam(addr) {
        if (!this.ramEnabled || !this.ramEnabled2 || addr >= 0xb000) return 0xff;
        switch ((addr >> 4) & 0xf) {
            case 2: return this.latchX & 0xff;
            case 3: return this.latchX >> 8;
            case 4: return this.latchY & 0xff;
            case 5: return this.latchY >> 8;
            case 6: return 0;
            case 8: return (this.do ? 1 : 0) | (this.di ? 2 : 0) | (this.clk ? 0x40 : 0) | (this.cs ? 0x80 : 0);
            default: return 0xff;
        }
    }

    writeRam(addr, value) {
        if (!this.ramEnabled || !this.ramEnabled2 || addr >= 0xb000) return;
        switch ((addr >> 4) & 0xf) {
            case 0:
                if (value === 0x55) {
                    this.latchReady = true;
                    this.latchX = this.latchY = 0x8000;
                }
                break;
            case 1:
                if (value === 0xaa && this.latchReady) {
                    this.latchReady = false;
                    // Tilting right lowers X; tilting down lowers Y.
                    this.latchX = clamp(Math.round(CENTER - ONE_G * this.tiltX));
                    this.latchY = clamp(Math.round(CENTER - ONE_G * this.tiltY));
                }
                break;
            case 8:
                this.#eeprom(value);
                break;
        }
    }

    /** One write to the EEPROM pins: commands are shifted in on rising clock edges. */
    #eeprom(value) {
        this.cs = (value & 0x80) !== 0;
        this.di = (value & 2) !== 0;
        const rising = !this.clk && (value & 0x40) !== 0;
        this.clk = (value & 0x40) !== 0;
        if (!this.cs || !rising) return;

        this.do = (this.readBits & 0x8000) !== 0;
        this.readBits = ((this.readBits << 1) | 1) & 0xffff;
        if (this.argumentBits) {
            // Shifting in the 16 data bits of WRITE or WRAL.
            this.argumentBits--;
            this.do = true;
            if (this.di) {
                const bit = 1 << this.argumentBits;
                if (this.command & 0x100) this.#orWord(this.command & 0x7f, bit);
                else for (let i = 0; i < 128; i++) this.#orWord(i, bit);
            }
            if (!this.argumentBits) {
                this.command = 0;
                this.readBits = 0xff; // busy for a few clocks, then ready
            }
            return;
        }

        this.command = ((this.command << 1) | (this.di ? 1 : 0)) & 0x7ff;
        if (!(this.command & 0x400)) return; // the start bit hasn't reached the top yet
        const address = this.command & 0x7f;
        switch ((this.command >> 6) & 0xf) {
            case 0x8: case 0x9: case 0xa: case 0xb: // READ
                this.readBits = this.ram[address * 2] | (this.ram[address * 2 + 1] << 8);
                this.command = 0;
                break;
            case 0x3: // EWEN
                this.writeEnabled = true;
                this.command = 0;
                break;
            case 0x0: // EWDS
                this.writeEnabled = false;
                this.command = 0;
                break;
            case 0x4: case 0x5: case 0x6: case 0x7: // WRITE, then 16 data bits
                if (this.writeEnabled) this.#setWord(address, 0);
                this.argumentBits = 16;
                break;
            case 0xc: case 0xd: case 0xe: case 0xf: // ERASE
                if (this.writeEnabled) {
                    this.#setWord(address, 0xffff);
                    this.readBits = 0x3fff;
                }
                this.command = 0;
                break;
            case 0x2: // ERAL
                if (this.writeEnabled) {
                    this.ram.fill(0xff);
                    this.readBits = 0xff;
                }
                this.command = 0;
                break;
            case 0x1: // WRAL, then 16 data bits
                if (this.writeEnabled) this.ram.fill(0);
                this.argumentBits = 16;
                break;
        }
    }

    #setWord(index, value) {
        if (!this.writeEnabled) return;
        this.ram[index * 2] = value & 0xff;
        this.ram[index * 2 + 1] = value >> 8;
    }

    #orWord(index, bit) {
        if (!this.writeEnabled) return;
        if (bit & 0xff) this.ram[index * 2] |= bit;
        else this.ram[index * 2 + 1] |= bit >> 8;
    }
}

function clamp(value) {
    return Math.max(0, Math.min(0xffff, value));
}
