import { Cartridge } from "./base.js";

// TAMA5 registers (selected by writing A001, accessed through A000).
const BANK_LO = 0x0;
const BANK_HI = 0x1;
const WRITE_LO = 0x4;
const WRITE_HI = 0x5;
const ADDR_HI = 0x6;
const ADDR_LO = 0x7;
const ACTIVE = 0xa;
const READ_LO = 0xc;
const READ_HI = 0xd;

// TAMA6 clock: timer page nibbles.
const SECOND_1 = 0x0;
const MINUTE_1 = 0x2;
const HOUR_1 = 0x4;
const WEEK = 0x6;
const DAY_1 = 0x7;
const MONTH_1 = 0x9;
const YEAR_1 = 0xb;
const PAGE = 0xd;
const TWENTY_FOUR_HOUR = 0xa; // in the alarm page
const LEAP_YEAR = 0xb; // in the alarm page
// Valid bits per timer page (0x00-0x0F) and alarm page (0x10-0x1F) nibble.
const MASKS = [
    0xf, 0x7, 0xf, 0x7, 0xf, 0x3, 0x7, 0xf, 0x3, 0xf, 0x1, 0xf, 0xf, 0x0, 0x0, 0x0,
    0x0, 0x0, 0xf, 0x7, 0xf, 0x3, 0x7, 0xf, 0x3, 0x0, 0x1, 0x3, 0x0, 0x0, 0x0, 0x0,
];
const CLOCK_SAVE_SIZE = 40;

/**
 * Bandai TAMA5 (Game de Hakken!! Tamagotchi 3): a mapper reached through
 * two addresses, 32 bytes of RAM and a TAMA6 clock chip with BCD date and
 * time. The clock follows the wall clock. Based on mGBA's research.
 */
export class Tama5 extends Cartridge {
    constructor(options) {
        super({ ...options, ramSize: 32, battery: true });
        this.now = options.now ?? Date.now;
        this.timerPage = new Uint8Array(16);
        this.alarmPage = new Uint8Array(16);
        this.freePage0 = new Uint8Array(16);
        this.freePage1 = new Uint8Array(16);
        this.timerPage[DAY_1] = 1;
        this.timerPage[MONTH_1] = 1;
        this.alarmPage[TWENTY_FOUR_HOUR] = 1;
        this.lastLatch = Math.floor(this.now() / 1000);
        this.clockEnabled = true;
    }

    reset() {
        super.reset();
        this.registers = new Uint8Array(8);
        this.selected = 0;
        this.ramEnabled = true;
    }

    sync(s) {
        super.sync(s);
        s.bytes(this.registers);
        for (const page of [this.timerPage, this.alarmPage, this.freePage0, this.freePage1]) s.bytes(page);
        this.selected = s.u8(this.selected);
        this.lastLatch = s.f64(this.lastLatch);
        this.clockEnabled = s.bool(this.clockEnabled);
    }

    writeRom() {}

    readRam(addr) {
        if (addr & 1) return 0xff;
        const regs = this.registers;
        if (this.selected === ACTIVE) return 0xf1;
        if (this.selected !== READ_LO && this.selected !== READ_HI) return 0xf1;
        const address = ((regs[ADDR_HI] << 4) & 0x10) | regs[ADDR_LO];
        let value = 0;
        switch (regs[ADDR_HI] >> 1) {
            case 1: // RAM read
                value = this.ram[address];
                break;
            case 2: // minute/hour read
                this.#latch();
                if (address === 6) value = (this.timerPage[MINUTE_1 + 1] << 4) | this.timerPage[MINUTE_1];
                else if (address === 7) value = (this.timerPage[HOUR_1 + 1] << 4) | this.timerPage[HOUR_1];
                else value = address;
                break;
            case 4: // clock page read
                this.#latch();
                value = regs[WRITE_LO] <= PAGE ? this.timerPage[regs[WRITE_LO]] : 0;
                break;
        }
        if (this.selected === READ_HI) value >>= 4;
        return 0xf0 | (value & 0x0f);
    }

    writeRam(addr, value) {
        if (addr & 1) {
            this.selected = value & 0x0f;
            return;
        }
        if (this.selected >= 8) return;
        const regs = this.registers;
        regs[this.selected] = value & 0x0f;
        if (this.selected === BANK_LO || this.selected === BANK_HI) {
            this.romOffset1 = (((regs[BANK_HI] << 4) | regs[BANK_LO]) & this.romMask) * 0x4000;
            return;
        }
        if (this.selected !== ADDR_LO) return;
        const address = ((regs[ADDR_HI] << 4) & 0x10) | regs[ADDR_LO];
        const out = (regs[WRITE_HI] << 4) | regs[WRITE_LO];
        switch (regs[ADDR_HI] >> 1) {
            case 0: // RAM write
                this.ram[address] = out;
                break;
            case 2: // commands
                this.#latch();
                if (address === 0x00) this.clockEnabled = false;
                else if (address === 0x01) {
                    this.clockEnabled = true;
                    this.timerPage[SECOND_1] = this.timerPage[SECOND_1 + 1] = 0;
                } else if (address === 0x04) {
                    this.timerPage[MINUTE_1] = out & 0x0f;
                    this.timerPage[MINUTE_1 + 1] = out >> 4;
                } else if (address === 0x05) {
                    this.timerPage[HOUR_1] = out & 0x0f;
                    this.timerPage[HOUR_1 + 1] = out >> 4;
                }
                break;
            case 4: { // clock page write
                this.#latch();
                const register = regs[WRITE_LO];
                if (register >= PAGE) break;
                const nibble = regs[WRITE_HI];
                switch (regs[ADDR_LO]) {
                    case 0: this.timerPage[register] = nibble & MASKS[register]; break;
                    case 2: this.alarmPage[register] = nibble & MASKS[register | 0x10]; break;
                    case 4: this.freePage0[register] = nibble; break;
                    case 6: this.freePage1[register] = nibble; break;
                }
                break;
            }
        }
    }

    /** Advances the BCD timer page by the wall-clock time since the last access. */
    #latch() {
        const now = Math.floor(this.now() / 1000);
        const elapsed = now - this.lastLatch;
        this.lastLatch = now;
        if (elapsed <= 0 || !this.clockEnabled) return;
        const t = this.timerPage;
        const bcd = (index) => t[index] + t[index + 1] * 10;
        const hour24 = this.alarmPage[TWENTY_FOUR_HOUR] !== 0;
        // 12-hour mode: hour-tens bit 1 is PM.
        const hour = hour24 ? bcd(HOUR_1) : t[HOUR_1] + (t[HOUR_1 + 1] & 1) * 10 + (t[HOUR_1 + 1] & 2 ? 12 : 0);
        const before = Date.UTC(2000 + bcd(YEAR_1), Math.max(0, bcd(MONTH_1) - 1), Math.max(1, bcd(DAY_1)), hour,
            bcd(MINUTE_1), bcd(SECOND_1));
        const date = new Date(before + elapsed * 1000);
        const days = Math.floor(date.getTime() / 86400000) - Math.floor(before / 86400000);
        const set = (index, value) => {
            t[index] = value % 10;
            t[index + 1] = Math.floor(value / 10);
        };
        set(SECOND_1, date.getUTCSeconds());
        set(MINUTE_1, date.getUTCMinutes());
        const h = date.getUTCHours();
        if (hour24) set(HOUR_1, h);
        else {
            t[HOUR_1] = (h % 12) % 10;
            t[HOUR_1 + 1] = Math.floor((h % 12) / 10) + (h >= 12 ? 2 : 0);
        }
        set(DAY_1, date.getUTCDate());
        set(MONTH_1, date.getUTCMonth() + 1);
        set(YEAR_1, date.getUTCFullYear() % 100);
        t[WEEK] = (t[WEEK] + days) % 7;
        this.alarmPage[LEAP_YEAR] = date.getUTCFullYear() & 3;
    }

    getSaveData() {
        const data = new Uint8Array(this.ram.length + CLOCK_SAVE_SIZE);
        data.set(this.ram);
        let offset = this.ram.length;
        for (const page of [this.timerPage, this.alarmPage, this.freePage0, this.freePage1]) {
            for (let i = 0; i < 8; i++) data[offset + i] = (page[i * 2] & 0x0f) | (page[i * 2 + 1] << 4);
            offset += 8;
        }
        new DataView(data.buffer).setFloat64(offset, this.lastLatch, true);
        return data;
    }

    loadSaveData(data) {
        super.loadSaveData(data);
        if (data.length < this.ram.length + CLOCK_SAVE_SIZE) return;
        let offset = this.ram.length;
        for (const page of [this.timerPage, this.alarmPage, this.freePage0, this.freePage1]) {
            for (let i = 0; i < 8; i++) {
                page[i * 2] = data[offset + i] & 0x0f;
                page[i * 2 + 1] = data[offset + i] >> 4;
            }
            offset += 8;
        }
        const last = new DataView(data.buffer, data.byteOffset).getFloat64(offset, true);
        if (Number.isFinite(last)) this.lastLatch = last;
    }
}
