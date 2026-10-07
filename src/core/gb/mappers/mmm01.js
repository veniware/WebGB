import { Cartridge } from './base.js';

/**
 * MMM01: multi-game compilations (Momotarou Collection 2, Taito Variety
 * Pack, ...). It starts "unmapped", showing the menu in the last 32 KiB of
 * the ROM; the menu sets extra bank bits to select a game, then enables
 * mapping, after which the MMM01 behaves like an MBC1 for that game.
 * Based on Pan Docs.
 */
export class Mmm01 extends Cartridge {
    reset() {
        super.reset();
        this.mapped = false;
        this.romLow = 0; // 5 bits; the MBC1 bank register
        this.romMid = 0; // 2 bits
        this.romHigh = 0; // 2 bits
        this.lowBankMask = 0; // write-protects bits of romLow (bits 1-4)
        this.ramLow = 0; // 2 bits; the MBC1 RAM bank register
        this.ramHigh = 0;
        this.ramMaskBits = 0;
        this.mode = 0;
        this.modeLocked = false;
        this.multiplex = false;
        this.remap();
    }

    sync(s) {
        super.sync(s);
        for (const field of ['romLow', 'romMid', 'romHigh', 'lowBankMask', 'ramLow', 'ramHigh', 'ramMaskBits', 'mode']) {
            this[field] = s.u8(this[field]);
        }
        for (const flag of ['mapped', 'modeLocked', 'multiplex']) this[flag] = s.bool(this[flag]);
        if (s.reading) this.remap();
    }

    writeRom(addr, value) {
        switch (addr >> 13) {
            case 0:
                this.ramEnabled = (value & 0x0f) === 0x0a;
                if (!this.mapped) {
                    this.ramMaskBits = (value >> 4) & 3;
                    if (value & 0x40) this.mapped = true;
                }
                break;
            case 1: {
                // Masked bits of the low bank can't be written.
                const writable = 0x1f & ~this.lowBankMask;
                this.romLow = (this.romLow & ~writable) | (value & writable);
                if (!this.mapped) this.romMid = (value >> 5) & 3;
                break;
            }
            case 2: {
                const writable = 3 & ~this.ramMaskBits;
                this.ramLow = (this.ramLow & ~writable) | (value & writable);
                if (!this.mapped) {
                    this.ramHigh = (value >> 2) & 3;
                    this.romHigh = (value >> 4) & 3;
                    this.modeLocked = (value & 0x40) !== 0;
                }
                break;
            }
            default:
                if (!this.modeLocked) this.mode = value & 1;
                if (!this.mapped) {
                    this.lowBankMask = value & 0x1e;
                    this.multiplex = (value & 0x40) !== 0;
                }
        }
        this.remap();
    }

    /** Recomputes the mapped offsets from the registers. */
    remap() {
        const totalBanks = this.rom.length / 0x4000;
        if (!this.mapped) {
            // The menu: the last 32 KiB.
            this.romOffset0 = (totalBanks - 2) * 0x4000;
            this.romOffset1 = (totalBanks - 1) * 0x4000;
            this.ramOffset = 0;
            return;
        }
        const mid = this.multiplex ? this.ramLow : this.romMid;
        const ramMid = this.multiplex ? this.romMid : this.ramLow;
        // Game bank 0 can't be mapped to 4000-7FFF: the low bit is forced on.
        let low = this.romLow;
        if (!(low & ~this.lowBankMask & 0x1f)) low |= 1;
        const high = (this.romHigh << 7) | (mid << 5);
        const bank0Mid = this.multiplex && !this.mode ? mid & this.ramMaskBits : mid;
        this.romOffset0 = (((this.romHigh << 7) | (bank0Mid << 5) | (this.romLow & this.lowBankMask)) % totalBanks) * 0x4000;
        this.romOffset1 = ((high | low) % totalBanks) * 0x4000;
        const ramBank = this.mode || this.multiplex ? ramMid : ramMid & this.ramMaskBits;
        this.ramOffset = ((this.ramHigh << 2) | ramBank) * 0x2000;
    }
}
