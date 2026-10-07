// Cartridge save memory: SRAM, Flash (64/128 KB) or EEPROM (512 B / 8 KB),
// detected from the ID strings Nintendo's SDK puts in ROMs.

export const BackupType = { NONE: 'none', SRAM: 'sram', FLASH64: 'flash64', FLASH128: 'flash128', EEPROM: 'eeprom' };

export function detectBackup(rom) {
    if (contains(rom, 'FLASH1M_V')) return BackupType.FLASH128;
    if (contains(rom, 'FLASH512_V') || contains(rom, 'FLASH_V')) return BackupType.FLASH64;
    if (contains(rom, 'EEPROM_V')) return BackupType.EEPROM;
    if (contains(rom, 'SRAM_V') || contains(rom, 'SRAM_F_V')) return BackupType.SRAM;
    return BackupType.NONE;
}

/** Whether the ROM contains the ASCII text. */
function contains(rom, text) {
    const first = text.charCodeAt(0);
    for (let i = rom.indexOf(first); i >= 0; i = rom.indexOf(first, i + 1)) {
        let k = 1;
        while (k < text.length && rom[i + k] === text.charCodeAt(k)) k++;
        if (k === text.length) return true;
    }
    return false;
}

export class Backup {
    /** @param {string} type BackupType */
    constructor(type) {
        this.type = type;
        this.eeprom = type === BackupType.EEPROM;
        const size = {
            [BackupType.SRAM]: 0x8000, [BackupType.FLASH64]: 0x10000, [BackupType.FLASH128]: 0x20000,
            [BackupType.EEPROM]: 0x2000, [BackupType.NONE]: 0x8000,
        }[type];
        this.data = new Uint8Array(size).fill(0xff);
        // EEPROM: 512 bytes or 8 KB, found from the first transfer.
        this.eepromBits = 0;
        // Counts writes (the host screenshots the moment the game saves).
        this.writes = 0;
        // An accelerometer sharing the address space (see tilt.js), or null.
        this.tilt = null;
        this.reset();
    }

    reset() {
        // Flash command state.
        this.flashStage = 0;
        this.flashIdMode = false;
        this.flashEraseArmed = false;
        this.flashWriteArmed = false;
        this.flashBankArmed = false;
        this.flashBank = 0;
        // EEPROM serial state.
        this.eepromIn = [];
        this.eepromOut = [];
        this.eepromAddress = 0;
        this.dirty = false;
    }

    sync(s) {
        s.bytes(this.data);
        this.flashBank = s.u8(this.flashBank);
        this.eepromBits = s.u8(this.eepromBits);
    }

    get flash() {
        return this.type === BackupType.FLASH64 || this.type === BackupType.FLASH128;
    }

    /** Raw save data, as other emulators store it (.sav). */
    getSaveData() {
        if (this.type === BackupType.EEPROM) return this.data.subarray(0, this.eepromBits === 6 ? 0x200 : 0x2000);
        return this.data;
    }

    loadSaveData(data) {
        this.data.fill(0xff);
        this.data.set(data.subarray(0, this.data.length));
        if (this.type === BackupType.EEPROM) this.eepromBits = data.length <= 0x200 ? 6 : 14;
    }

    // --- SRAM and Flash (0x0E000000) -------------------------------------------------

    read8(address) {
        if (this.tilt?.handles(address)) return this.tilt.read(address);
        if (this.flash) {
            if (this.flashIdMode && address < 2) {
                // Maker and device: Panasonic (64 KB), Sanyo (128 KB).
                return this.type === BackupType.FLASH128 ? [0x62, 0x13][address] : [0x32, 0x1b][address];
            }
            return this.data[(this.flashBank << 16) | address];
        }
        if (this.type === BackupType.EEPROM) return 0xff;
        return this.data[address & 0x7fff];
    }

    write8(address, value) {
        if (this.tilt?.handles(address)) {
            this.tilt.write(address, value);
            return;
        }
        if (this.flash) {
            this.#flashWrite(address, value);
            return;
        }
        if (this.type === BackupType.EEPROM) return;
        if (this.data[address & 0x7fff] !== value) this.writes++;
        this.data[address & 0x7fff] = value;
    }

    #flashWrite(address, value) {
        if (this.flashWriteArmed) {
            this.flashWriteArmed = false;
            this.data[(this.flashBank << 16) | address] &= value;
            this.writes++;
            return;
        }
        if (this.flashBankArmed && address === 0) {
            this.flashBankArmed = false;
            if (this.type === BackupType.FLASH128) this.flashBank = value & 1;
            return;
        }
        if (this.flashStage === 0 && address === 0x5555 && value === 0xaa) {
            this.flashStage = 1;
            return;
        }
        if (this.flashStage === 1 && address === 0x2aaa && value === 0x55) {
            this.flashStage = 2;
            return;
        }
        if (this.flashStage === 2) {
            this.flashStage = 0;
            if (this.flashEraseArmed) {
                this.flashEraseArmed = false;
                this.writes++;
                if (address === 0x5555 && value === 0x10) this.data.fill(0xff);
                else if (value === 0x30) {
                    const start = (this.flashBank << 16) | (address & 0xf000);
                    this.data.fill(0xff, start, start + 0x1000);
                }
                return;
            }
            if (address !== 0x5555) return;
            switch (value) {
                case 0x90: this.flashIdMode = true; break;
                case 0xf0: this.flashIdMode = false; break;
                case 0x80: this.flashEraseArmed = true; break;
                case 0xa0: this.flashWriteArmed = true; break;
                case 0xb0: this.flashBankArmed = true; break;
            }
            return;
        }
        this.flashStage = 0;
    }

    // --- EEPROM (0x0D000000, 1 bit per access) ---------------------------------------

    isEeprom(address, romSize) {
        return romSize > 0x1000000 ? (address & 0x00ffff00) === 0x00ffff00 : true;
    }

    /** DMA 3 transfer lengths reveal the address size (6 bits: 512 B, 14 bits: 8 KB). */
    eepromTransfer(count) {
        if (this.eepromBits) return;
        if (count === 9 || count === 73) this.eepromBits = 6;
        else if (count === 17 || count === 81) this.eepromBits = 14;
    }

    readEeprom() {
        if (this.eepromOut.length) return this.eepromOut.shift();
        return 1; // ready
    }

    writeEeprom(value) {
        const bits = this.eepromIn;
        bits.push(value & 1);
        const addressBits = this.eepromBits || 14;
        if (bits.length < 2) return;
        const command = (bits[0] << 1) | bits[1];
        if (command === 3 && bits.length === 2 + addressBits + 1) {
            // Read: 4 dummy bits, then 64 data bits.
            const block = this.#address(bits, addressBits);
            this.eepromOut = [0, 0, 0, 0];
            for (let i = 0; i < 64; i++) this.eepromOut.push((this.data[block * 8 + (i >> 3)] >> (7 - (i & 7))) & 1);
            this.eepromIn = [];
        } else if (command === 2 && bits.length === 2 + addressBits + 64 + 1) {
            const block = this.#address(bits, addressBits);
            for (let i = 0; i < 8; i++) {
                let byte = 0;
                for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[2 + addressBits + i * 8 + b];
                this.data[block * 8 + i] = byte;
            }
            this.writes++;
            this.eepromOut = [];
            this.eepromIn = [];
        } else if (command < 2) {
            this.eepromIn = [];
        }
    }

    #address(bits, addressBits) {
        let address = 0;
        for (let i = 0; i < addressBits; i++) address = (address << 1) | bits[2 + i];
        return address & 0x3ff;
    }
}
