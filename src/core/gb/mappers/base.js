import { Rtc, RTC_SAVE_SIZE } from "../rtc.js";

/** ROM only (optionally with RAM); also the base class of the mappers. */
export class Cartridge {
    /**
     * @param {{ data: Uint8Array, ramSize: number, battery?: boolean, rtc?: boolean, rumble?: boolean,
     *     now?: () => number }} options
     */
    constructor({ data, ramSize, battery = false, rtc = false, rumble = false, now }) {
        this.rom = data;
        this.ram = new Uint8Array(ramSize);
        this.hasBattery = battery;
        this.rtc = rtc ? new Rtc(now) : null;
        this.hasRumble = rumble;
        // Rumble motor state, tilt sensor input and IR light: see GameBoy.
        this.rumbling = false;
        // Mappers with timed work (camera captures) set this and implement tick(cycles).
        this.ticking = false;
        this.romMask = data.length / 0x4000 - 1;
        this.ramMask = Math.max(ramSize - 1, 0);
        this.reset();
    }

    /** Mapper registers back to power-on values. RAM (battery) and RTC are kept. */
    reset() {
        this.ramEnabled = this.constructor === Cartridge;
        this.romOffset0 = 0;
        this.romOffset1 = 0x4000;
        this.ramOffset = 0;
    }

    readRom(addr) {
        return addr < 0x4000 ? this.rom[this.romOffset0 + addr] : this.rom[this.romOffset1 + (addr & 0x3fff)];
    }

    /** Writes to 0000-7FFF set mapper registers. */
    writeRom(_addr, _value) {}

    readRam(addr) {
        if (!this.ramEnabled || !this.ram.length) return 0xff;
        return this.ram[(this.ramOffset + (addr & 0x1fff)) & this.ramMask];
    }

    writeRam(addr, value) {
        if (this.ramEnabled && this.ram.length) this.ram[(this.ramOffset + (addr & 0x1fff)) & this.ramMask] = value;
    }

    /** Battery-backed data for saved games, or null. */
    getSaveData() {
        if (!this.hasBattery) return null;
        if (!this.rtc) return this.ram;
        const data = new Uint8Array(this.ram.length + RTC_SAVE_SIZE);
        data.set(this.ram);
        data.set(this.rtc.toSave(), this.ram.length);
        return data;
    }

    loadSaveData(data) {
        this.ram.fill(0);
        this.ram.set(data.subarray(0, this.ram.length));
        const clock = data.subarray(this.ram.length);
        if (this.rtc && clock.length >= 44) this.rtc.fromSave(clock);
    }

    sync(s) {
        this.ramEnabled = s.bool(this.ramEnabled);
        this.romOffset0 = s.u32(this.romOffset0);
        this.romOffset1 = s.u32(this.romOffset1);
        this.ramOffset = s.u32(this.ramOffset);
        s.bytes(this.ram);
        this.rtc?.sync(s);
    }
}
