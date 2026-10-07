import { Cartridge } from './base.js';

const FLASH_SIZE = 0x100000;
const SECTOR_SIZE = 0x20000;

/**
 * MBC6 (Net de Get: Minigame @ 100): two independently switched 8 KiB
 * ROM/flash windows at 4000 and 6000, two 4 KiB RAM windows at A000 and
 * B000, and 1 MiB of flash the game downloads minigames into. RAM and
 * flash are the saved game. Based on Pan Docs.
 */
export class Mbc6 extends Cartridge {
    constructor(options) {
        super({ ...options, ramSize: 0x8000, battery: true });
        this.flash = new Uint8Array(FLASH_SIZE).fill(0xff);
    }

    reset() {
        super.reset();
        this.romBank = [0, 0];
        this.useFlash = [false, false];
        this.ramBank = [0, 0];
        this.flashEnabled = false;
        this.flashWriteEnabled = false;
        // Flash command state machine.
        this.unlock = 0; // progress through the AA/55 unlock sequence
        this.flashMode = 'read'; // 'read' | 'id' | 'program' | 'status' | 'erase-setup'
        this.status = 0x80;
    }

    sync(s) {
        super.sync(s);
        s.bytes(this.flash);
        for (let i = 0; i < 2; i++) {
            this.romBank[i] = s.u8(this.romBank[i]);
            this.ramBank[i] = s.u8(this.ramBank[i]);
            this.useFlash[i] = s.bool(this.useFlash[i]);
        }
        this.flashEnabled = s.bool(this.flashEnabled);
        this.flashWriteEnabled = s.bool(this.flashWriteEnabled);
        this.unlock = s.u8(this.unlock);
        const modes = ['read', 'id', 'program', 'status', 'erase-setup'];
        this.flashMode = modes[s.u8(modes.indexOf(this.flashMode))] ?? 'read';
        this.status = s.u8(this.status);
    }

    readRom(addr) {
        if (addr < 0x4000) return this.rom[addr];
        const window = addr < 0x6000 ? 0 : 1;
        const offset = this.romBank[window] * 0x2000 + (addr & 0x1fff);
        if (!this.useFlash[window]) return this.rom[offset % this.rom.length];
        if (!this.flashEnabled) return 0xff;
        if (this.flashMode === 'id') return (addr & 1) ? 0x81 : 0xc2;
        if (this.flashMode === 'status' || this.flashMode === 'program') return this.status;
        return this.flash[offset & (FLASH_SIZE - 1)];
    }

    writeRom(addr, value) {
        if (addr < 0x2000) {
            switch (addr >> 10) {
                case 0: this.ramEnabled = (value & 0x0f) === 0x0a; break;
                case 1: this.ramBank[0] = value & 7; break;
                case 2: this.ramBank[1] = value & 7; break;
                case 3: this.flashEnabled = (value & 1) !== 0; break;
                default: if (addr === 0x1000) this.flashWriteEnabled = (value & 1) !== 0;
            }
        } else if (addr < 0x4000) {
            const window = addr < 0x3000 ? 0 : 1;
            if (addr & 0x800) this.useFlash[window] = (value & 8) !== 0;
            else this.romBank[window] = value & 0x7f;
        } else if (this.flashEnabled) {
            const window = addr < 0x6000 ? 0 : 1;
            if (this.useFlash[window]) this.#flashWrite(this.romBank[window] * 0x2000 + (addr & 0x1fff), value);
        }
    }

    /** Flash commands: AA to 5555, 55 to 2AAA, then the command (Pan Docs table). */
    #flashWrite(address, value) {
        const offset = address & (FLASH_SIZE - 1);
        if (value === 0xf0) {
            this.flashMode = 'read';
            this.unlock = 0;
            return;
        }
        if (this.flashMode === 'program') {
            // Bits can only be cleared; the 128-byte block is committed by writing its last address again.
            this.flash[offset] &= value;
            this.status = 0x80;
            return;
        }
        const low = offset & 0x7fff;
        if (this.unlock === 0 && low === 0x5555 && value === 0xaa) {
            this.unlock = 1;
        } else if (this.unlock === 1 && low === 0x2aaa && value === 0x55) {
            this.unlock = 2;
        } else if (this.unlock === 2) {
            this.unlock = 0;
            if (this.flashMode === 'erase-setup') {
                if (value === 0x30) this.#erase(offset - (offset % SECTOR_SIZE), SECTOR_SIZE);
                else if (value === 0x10) this.#erase(0, FLASH_SIZE);
                this.flashMode = 'status';
                this.status = 0x80;
            } else if (value === 0x80) {
                this.flashMode = 'erase-setup';
            } else if (value === 0x90) {
                this.flashMode = 'id';
            } else if (value === 0xa0) {
                this.flashMode = 'program';
                this.status = 0x80;
            }
        } else {
            this.unlock = 0;
        }
    }

    #erase(start, length) {
        // Sector 0 is write-protected unless the cartridge's write enable is on.
        const from = !this.flashWriteEnabled && start === 0 ? SECTOR_SIZE : start;
        if (from < start + length) this.flash.fill(0xff, from, start + length);
    }

    readRam(addr) {
        if (!this.ramEnabled) return 0xff;
        const window = addr < 0xb000 ? 0 : 1;
        return this.ram[this.ramBank[window] * 0x1000 + (addr & 0xfff)];
    }

    writeRam(addr, value) {
        if (!this.ramEnabled) return;
        const window = addr < 0xb000 ? 0 : 1;
        this.ram[this.ramBank[window] * 0x1000 + (addr & 0xfff)] = value;
    }

    getSaveData() {
        const data = new Uint8Array(this.ram.length + FLASH_SIZE);
        data.set(this.ram);
        data.set(this.flash, this.ram.length);
        return data;
    }

    loadSaveData(data) {
        super.loadSaveData(data);
        if (data.length >= this.ram.length + FLASH_SIZE) this.flash.set(data.subarray(this.ram.length, this.ram.length + FLASH_SIZE));
    }
}
