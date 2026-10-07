import { Cartridge } from './base.js';

// The common mappers: MBC1 (and its multicart wiring), MBC2, MBC3, MBC5, HuC1.

export class Mbc1 extends Cartridge {
    constructor(options) {
        super(options);
        // Multicarts wire only 4 bits of the low bank register; detected by a
        // second Nintendo logo at the start of bank 0x10.
        this.multicart = this.rom.length === 0x100000 && sameBytes(this.rom, 0x104, 0x40104, 48);
    }

    reset() {
        super.reset();
        this.bank1 = 1;
        this.bank2 = 0;
        this.mode = 0;
    }

    writeRom(addr, value) {
        switch (addr >> 13) {
            case 0: this.ramEnabled = (value & 0x0f) === 0x0a; break;
            case 1: this.bank1 = value & 0x1f || 1; break;
            case 2: this.bank2 = value & 3; break;
            default: this.mode = value & 1;
        }
        this.#update();
    }

    #update() {
        const shift = this.multicart ? 4 : 5;
        const low = this.multicart ? this.bank1 & 0x0f : this.bank1;
        const high = this.bank2 << shift;
        this.romOffset1 = ((high | low) & this.romMask) * 0x4000;
        this.romOffset0 = this.mode ? (high & this.romMask) * 0x4000 : 0;
        this.ramOffset = this.mode ? this.bank2 * 0x2000 : 0;
    }

    sync(s) {
        super.sync(s);
        this.bank1 = s.u8(this.bank1);
        this.bank2 = s.u8(this.bank2);
        this.mode = s.u8(this.mode);
    }
}

/** MBC2: 512 half-bytes of built-in RAM, mirrored across A000-BFFF. */
export class Mbc2 extends Cartridge {
    writeRom(addr, value) {
        if (addr >= 0x4000) return;
        // Address bit 8 selects the register.
        if (addr & 0x100) this.romOffset1 = ((value & 0x0f || 1) & this.romMask) * 0x4000;
        else this.ramEnabled = (value & 0x0f) === 0x0a;
    }

    readRam(addr) {
        return this.ramEnabled ? this.ram[addr & 0x1ff] | 0xf0 : 0xff;
    }

    writeRam(addr, value) {
        if (this.ramEnabled) this.ram[addr & 0x1ff] = value & 0x0f;
    }
}

export class Mbc3 extends Cartridge {
    reset() {
        super.reset();
        this.ramBank = 0;
        this.latchValue = 0xff;
    }

    writeRom(addr, value) {
        switch (addr >> 13) {
            case 0: this.ramEnabled = (value & 0x0f) === 0x0a; break;
            case 1: {
                // 7-bit bank numbers; the MBC30 (4 MB ROMs) has 8.
                const bank = value & (this.romMask > 0x7f ? 0xff : 0x7f);
                this.romOffset1 = ((bank || 1) & this.romMask) * 0x4000;
                break;
            }
            case 2:
                this.ramBank = value & 0x0f;
                this.ramOffset = (this.ramBank & 7) * 0x2000;
                break;
            default:
                if (this.latchValue === 0 && value === 1) this.rtc?.latch();
                this.latchValue = value;
        }
    }

    readRam(addr) {
        if (!this.ramEnabled) return 0xff;
        if (this.ramBank < 8) return super.readRam(addr);
        if (this.rtc && this.ramBank >= 8 && this.ramBank <= 0x0c) return this.rtc.read(this.ramBank);
        return 0xff;
    }

    writeRam(addr, value) {
        if (!this.ramEnabled) return;
        if (this.ramBank < 8) super.writeRam(addr, value);
        else if (this.rtc && this.ramBank >= 8 && this.ramBank <= 0x0c) this.rtc.write(this.ramBank, value);
    }

    sync(s) {
        super.sync(s);
        this.ramBank = s.u8(this.ramBank);
        this.latchValue = s.u8(this.latchValue);
    }
}

export class Mbc5 extends Cartridge {
    reset() {
        super.reset();
        this.romBank = 1;
        this.rumbling = false;
    }

    writeRom(addr, value) {
        if (addr < 0x2000) {
            this.ramEnabled = (value & 0x0f) === 0x0a;
        } else if (addr < 0x3000) {
            this.romBank = (this.romBank & 0x100) | value;
        } else if (addr < 0x4000) {
            this.romBank = (this.romBank & 0xff) | ((value & 1) << 8);
        } else if (addr < 0x6000) {
            // On rumble cartridges bit 3 drives the motor instead of selecting RAM.
            this.rumbling = this.hasRumble && (value & 0x08) !== 0;
            this.ramOffset = (value & (this.hasRumble ? 0x07 : 0x0f)) * 0x2000;
        }
        this.romOffset1 = (this.romBank & this.romMask) * 0x4000;
    }

    sync(s) {
        super.sync(s);
        this.romBank = s.u16(this.romBank);
        this.rumbling = s.bool(this.rumbling);
    }
}

/** HuC1: ROM/RAM banking and an infrared LED and sensor instead of a RAM enable. */
export class Huc1 extends Cartridge {
    reset() {
        super.reset();
        this.ramEnabled = true;
        this.irMode = false;
        this.irLight = false;
        this.irReceived = false;
    }

    writeRom(addr, value) {
        switch (addr >> 13) {
            case 0: this.irMode = (value & 0x0f) === 0x0e; break;
            case 1: this.romOffset1 = ((value & 0x3f || 1) & this.romMask) * 0x4000; break;
            case 2: this.ramOffset = (value & 3) * 0x2000; break;
        }
    }

    readRam(addr) {
        return this.irMode ? 0xc0 | (this.irReceived ? 1 : 0) : super.readRam(addr);
    }

    writeRam(addr, value) {
        if (this.irMode) this.irLight = (value & 1) !== 0;
        else super.writeRam(addr, value);
    }

    sync(s) {
        super.sync(s);
        this.irMode = s.bool(this.irMode);
        this.irLight = s.bool(this.irLight);
    }
}

function sameBytes(data, a, b, length) {
    for (let i = 0; i < length; i++) if (data[a + i] !== data[b + i]) return false;
    return true;
}
