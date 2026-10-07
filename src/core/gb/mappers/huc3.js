import { Cartridge } from "./base.js";

const DAY_MINUTES = 1440;
// Clock data appended to saved games: base time (8), alarm minutes (2), alarm days (2), alarm on (1).
const CLOCK_SAVE_SIZE = 16;

/**
 * HuC3 (Hudson: Robopon, Pocket Family, ...): banking, a clock run by a
 * small microcontroller that games talk to through mailbox registers, a
 * tone generator and infrared. Like the MBC3 clock, it follows the wall
 * clock. Based on Pan Docs and SameBoy (MIT).
 */
export class Huc3 extends Cartridge {
    constructor(options) {
        super({ ...options, battery: true });
        this.now = options.now ?? Date.now;
        // Wall-clock time (ms) at which the minute counter was 0.
        this.base = this.now();
        this.alarmMinutes = 0;
        this.alarmDays = 0;
        this.alarmEnabled = false;
    }

    reset() {
        super.reset();
        this.mode = 0;
        this.accessIndex = 0;
        this.accessFlags = 0;
        this.readValue = 0;
        this.irLight = false;
        this.irReceived = false;
    }

    sync(s) {
        super.sync(s);
        this.base = s.f64(this.base);
        for (const field of ["mode", "accessIndex", "accessFlags", "readValue"]) this[field] = s.u8(this[field]);
        this.alarmMinutes = s.u16(this.alarmMinutes);
        this.alarmDays = s.u16(this.alarmDays);
        this.alarmEnabled = s.bool(this.alarmEnabled);
        this.irLight = s.bool(this.irLight);
    }

    writeRom(addr, value) {
        if (addr < 0x2000) {
            this.mode = value & 0x0f;
            this.ramEnabled = this.mode === 0x0a;
        } else if (addr < 0x4000) {
            this.romOffset1 = ((value & 0x7f) & this.romMask) * 0x4000;
        } else if (addr < 0x6000) {
            this.ramOffset = (value & 3) * 0x2000;
        }
    }

    readRam(addr) {
        switch (this.mode) {
            case 0x0a:
            case 0x00:
                return this.ram.length ? this.ram[(this.ramOffset + (addr & 0x1fff)) & this.ramMask] : 0xff;
            case 0x0c: return this.accessFlags === 2 ? 1 : this.readValue;
            case 0x0d: return 1; // the clock MCU is always ready
            case 0x0e: return 0xc0 | (this.irReceived ? 1 : 0);
            default: return 0xff;
        }
    }

    writeRam(addr, value) {
        switch (this.mode) {
            case 0x0a: super.writeRam(addr, value); break;
            case 0x0b: this.#command(value); break;
            case 0x0e: this.irLight = (value & 1) !== 0; break;
        }
    }

    /** Commands to the clock MCU: read/write nibbles of its memory, set the address. */
    #command(value) {
        const argument = value & 0x0f;
        const index = this.accessIndex;
        switch ((value >> 4) & 7) {
            case 1: // read and advance
                this.readValue = this.#readNibble(index);
                this.accessIndex = (index + 1) & 0xff;
                break;
            case 2: // write
            case 3: // write and advance
                this.#writeNibble(index, argument);
                if (value >> 4 === 3) this.accessIndex = (index + 1) & 0xff;
                break;
            case 4: this.accessIndex = (index & 0xf0) | argument; break;
            case 5: this.accessIndex = (index & 0x0f) | (argument << 4); break;
            case 6: this.accessFlags = argument; break;
        }
    }

    // Locations 0-2 hold the minute of the day, 3-6 the day counter.
    #readNibble(index) {
        const { minutes, days } = this.#time();
        if (index < 3) return (minutes >> (index * 4)) & 0xf;
        if (index < 7) return (days >> ((index - 3) * 4)) & 0xf;
        if (index >= 0x58 && index <= 0x5a) return (this.alarmMinutes >> ((index - 0x58) * 4)) & 0xf;
        if (index >= 0x5b && index <= 0x5e) return (this.alarmDays >> ((index - 0x5b) * 4)) & 0xf;
        return 0;
    }

    #writeNibble(index, nibble) {
        if (index < 7) {
            let { minutes, days } = this.#time();
            if (index < 3) minutes = (minutes & ~(0xf << (index * 4))) | (nibble << (index * 4));
            else days = (days & ~(0xf << ((index - 3) * 4))) | (nibble << ((index - 3) * 4));
            this.base = this.now() - (days * DAY_MINUTES + minutes) * 60000;
        } else if (index >= 0x58 && index <= 0x5a) {
            const shift = (index - 0x58) * 4;
            this.alarmMinutes = (this.alarmMinutes & ~(0xf << shift)) | (nibble << shift);
        } else if (index >= 0x5b && index <= 0x5e) {
            const shift = (index - 0x5b) * 4;
            this.alarmDays = (this.alarmDays & ~(0xf << shift)) | (nibble << shift);
        } else if (index === 0x5f) {
            this.alarmEnabled = (nibble & 1) !== 0;
        }
    }

    #time() {
        const total = Math.max(0, Math.floor((this.now() - this.base) / 60000));
        return { minutes: total % DAY_MINUTES, days: Math.floor(total / DAY_MINUTES) & 0xffff };
    }

    getSaveData() {
        const data = new Uint8Array(this.ram.length + CLOCK_SAVE_SIZE);
        data.set(this.ram);
        const view = new DataView(data.buffer, this.ram.length);
        view.setFloat64(0, this.base, true);
        view.setUint16(8, this.alarmMinutes, true);
        view.setUint16(10, this.alarmDays, true);
        view.setUint8(12, this.alarmEnabled ? 1 : 0);
        return data;
    }

    loadSaveData(data) {
        super.loadSaveData(data);
        if (data.length < this.ram.length + CLOCK_SAVE_SIZE) return;
        const view = new DataView(data.buffer, data.byteOffset + this.ram.length);
        const base = view.getFloat64(0, true);
        if (Number.isFinite(base)) this.base = base;
        this.alarmMinutes = view.getUint16(8, true);
        this.alarmDays = view.getUint16(10, true);
        this.alarmEnabled = view.getUint8(12) !== 0;
    }
}
