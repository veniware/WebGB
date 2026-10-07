// Games with a real-time clock on the cartridge's GPIO port, by game code
// (the first three letters; the fourth is the region).
const RTC_GAMES = new Set([
    'AXV', 'AXP', // Pokémon Ruby, Sapphire
    'BPE', // Pokémon Emerald
    'U3I', 'U32', 'U33', // Boktai 1-3
    'BKA', // Sennen Kazoku
    'BR4', // Rockman EXE 4.5
]);

// Other devices on the GPIO port.
const SOLAR_GAMES = new Set(['U3I', 'U32', 'U33']); // Boktai 1-3
const GYRO_GAMES = new Set(['RZW']); // WarioWare: Twisted!
const RUMBLE_GAMES = new Set(['RZW', 'V49']); // and Drill Dozer
// Solar sensor: added to the darkness threshold per sunlight level 1-10 (after mGBA).
const LUX_LEVELS = [5, 11, 18, 27, 42, 62, 84, 109, 139, 183];
// Gyro: the reading at rest, and its change at full rotation input.
const GYRO_CENTER = 0x6c0;
const GYRO_RANGE = 0x300;

// Command codes as the bits arrive (the command byte is sent MSB first).
const Command = { RESET: 0, DATETIME: 2, IRQ: 3, CONTROL: 4, TIME: 6 };
// Data bytes of each command.
const COMMAND_BYTES = [0, 0, 7, 0, 1, 0, 3, 0];
// The status register: 24-hour mode.
const DEFAULT_CONTROL = 0x40;
const SAVE_MAGIC = 0x31435452; // "RTC1"

const bcd = (value) => ((value / 10) | 0) * 16 + (value % 10);
const fromBcd = (value) => (value >> 4) * 10 + (value & 0x0f);

/**
 * The cartridge GPIO port (0x080000C4-C9) and the devices behind it, by game:
 * - the Seiko S-3511A real-time clock: a serial protocol over three pins
 *     (SCK, SIO, CS). It follows the wall clock, shifted by whatever time the
 *     game sets.
 * - Boktai's solar sensor: pin 1 resets a counter that pin 0 clocks; pin 3
 *     goes high once it passes a threshold that drops with more light.
 * - WarioWare: Twisted!'s gyro: pin 0 samples the rotation, pin 1 clocks
 *     its bits out on pin 2.
 * - A rumble motor on pin 3.
 * The sensors' wiring follows mGBA.
 */
export class Gpio {
    /** Sunlight level 0-10 (solar sensor). */
    light = 0;
    /** Rotation input -1..1 (gyro). */
    rotation = 0;

    /**
     * @param {Uint8Array} rom
     * @param {{ now?: () => number, cycles?: () => number }} [options]
     *     now: milliseconds (for tests); cycles: the machine's clock (for rumble).
     */
    constructor(rom, { now = () => Date.now(), cycles = () => 0 } = {}) {
        const code = String.fromCharCode(...rom.subarray(0xac, 0xaf));
        this.rtc = RTC_GAMES.has(code);
        this.solar = SOLAR_GAMES.has(code);
        this.gyro = GYRO_GAMES.has(code);
        this.rumble = RUMBLE_GAMES.has(code);
        this.present = this.rtc || this.solar || this.gyro || this.rumble;
        this.now = now;
        this.cycles = cycles;
        this.time = new Uint8Array(7);
        this.reset();
        // The clock's offset from the wall clock (seconds) and its status
        // register survive resets: they are part of the saved game.
        this.offset = 0;
        this.control = DEFAULT_CONTROL;
    }

    reset() {
        this.data = 0;
        this.direction = 0;
        this.readable = false;
        // Pins driven by the clock (for the ones the GBA reads).
        this.output = 0;
        this.step = 0;
        this.sck = 0;
        this.sioIn = 0;
        this.bits = 0;
        this.bitCount = 0;
        this.command = -1;
        this.reading = false;
        this.remaining = 0;
        this.byteIndex = 0;
        // Pins driven by the sensors.
        this.sensorOutput = 0;
        this.lightCounter = 0;
        this.lightEdge = false;
        this.lightThreshold = 0xff;
        this.gyroSample = 0;
        this.gyroEdge = false;
        // Rumble: motor on, cycles it ran since the last getRumble(), since when.
        this.motor = false;
        this.motorCycles = 0;
        this.motorSince = 0;
    }

    sync(s) {
        for (const field of ['data', 'direction', 'output', 'step', 'sck', 'sioIn', 'bits', 'bitCount', 'remaining', 'byteIndex',
            'control']) {
            this[field] = s.u8(this[field]);
        }
        this.command = s.i32(this.command);
        this.readable = s.bool(this.readable);
        this.reading = s.bool(this.reading);
        this.offset = s.f64(this.offset);
        s.bytes(this.time);
        // Only for the games with these devices, so other games' states stay as they were.
        if (this.solar || this.gyro || this.rumble) {
            this.sensorOutput = s.u8(this.sensorOutput);
            this.lightCounter = s.u32(this.lightCounter);
            this.lightEdge = s.bool(this.lightEdge);
            this.lightThreshold = s.u8(this.lightThreshold);
            this.gyroSample = s.u16(this.gyroSample);
            this.gyroEdge = s.bool(this.gyroEdge);
            this.motor = s.bool(this.motor);
            this.motorCycles = s.f64(this.motorCycles);
            this.motorSince = s.f64(this.motorSince);
        }
    }

    read(offset) {
        if (offset & 1) return 0;
        switch (offset) {
            case 0xc4: return ((this.data & this.direction) | ((this.output | this.sensorOutput) & ~this.direction)) & 0xf;
            case 0xc6: return this.direction;
            default: return this.readable ? 1 : 0;
        }
    }

    write(offset, value) {
        switch (offset) {
            case 0xc4: {
                this.data = value & 0xf;
                const pins = (this.data & this.direction) | ((this.output | this.sensorOutput) & ~this.direction);
                if (this.rtc) this.#pins(pins);
                if (this.solar) this.#solarPins(pins);
                if (this.gyro) this.#gyroPins(pins);
                if (this.rumble) this.#motorPins();
                break;
            }
            case 0xc6: this.direction = value & 0xf; break;
            case 0xc8: this.readable = (value & 1) !== 0; break;
        }
    }

    /** The serial protocol: CS rising with SCK high starts a transfer; bits move on SCK rising edges. */
    #pins(pins) {
        const sck = pins & 1;
        const cs = pins & 4;
        const rising = sck && !this.sck;
        this.sck = sck;
        switch (this.step) {
            case 0:
                if (sck && !cs) this.step = 1;
                return;
            case 1:
                if (sck && cs) {
                    this.step = 2;
                    this.bitCount = 0;
                    this.bits = 0;
                    this.command = -1;
                } else if (!sck || cs) this.step = 0;
                return;
        }
        if (!cs) {
            // Transfer over.
            this.step = sck ? 1 : 0;
            this.command = -1;
            this.output = 1;
            return;
        }
        if (!sck) {
            // The GBA sets SIO while SCK is low; it is taken on the rising edge.
            this.sioIn = (pins >> 1) & 1;
            return;
        }
        if (!rising) return;
        if (this.command >= 0 && this.reading) {
            this.output = 5 | (((this.#readByte() >> this.bitCount) & 1) << 1);
            if (++this.bitCount === 8) {
                this.bitCount = 0;
                this.byteIndex++;
                if (--this.remaining <= 0) this.command = -1;
            }
            return;
        }
        this.bits |= this.sioIn << this.bitCount;
        if (++this.bitCount === 8) this.#byte(this.bits);
    }

    #solarPins(pins) {
        // Selected while pin 2 (the clock's CS) is low.
        if (pins & 4) return;
        if (pins & 2) {
            this.lightCounter = 0;
            this.lightThreshold = 0xff - 0x16 - (this.light > 0 ? LUX_LEVELS[Math.min(this.light, 10) - 1] : 0);
        }
        if (pins & 1 && this.lightEdge) this.lightCounter++;
        this.lightEdge = !(pins & 1);
        this.sensorOutput = (this.sensorOutput & ~8) | (this.lightCounter >= this.lightThreshold ? 8 : 0);
    }

    #gyroPins(pins) {
        if (pins & 1) {
            const rotation = Math.max(-1, Math.min(1, this.rotation));
            this.gyroSample = GYRO_CENTER + Math.round(rotation * GYRO_RANGE);
        }
        // A bit (MSB first) on each falling edge of pin 1.
        if (this.gyroEdge && !(pins & 2)) {
            this.sensorOutput = (this.sensorOutput & ~4) | ((this.gyroSample >> 13) & 4);
            this.gyroSample = (this.gyroSample << 1) & 0xffff;
        }
        this.gyroEdge = (pins & 2) !== 0;
    }

    #motorPins() {
        const on = (this.data & this.direction & 8) !== 0;
        if (on === this.motor) return;
        const now = this.cycles();
        if (this.motor) this.motorCycles += now - this.motorSince;
        this.motorSince = now;
        this.motor = on;
    }

    /** How much of the time since the last call the motor ran, 0-1. */
    rumbleLevel(since) {
        const now = this.cycles();
        const on = this.motorCycles + (this.motor ? now - Math.max(this.motorSince, since) : 0);
        this.motorCycles = 0;
        this.motorSince = now;
        return now > since ? Math.min(1, on / (now - since)) : 0;
    }

    #byte(value) {
        this.bits = 0;
        this.bitCount = 0;
        if (this.command < 0) {
            if ((value & 0x0f) !== 0x06) return;
            this.command = (value >> 4) & 7;
            this.reading = (value & 0x80) !== 0;
            this.remaining = COMMAND_BYTES[this.command];
            this.byteIndex = 0;
            if (this.command === Command.RESET) {
                this.control = 0;
                this.offset = 0;
            }
            if (this.command === Command.DATETIME || this.command === Command.TIME) this.#latch();
            if (!this.remaining) this.command = -1;
            return;
        }
        // A write.
        if (this.command === Command.CONTROL) this.control = value;
        else if (this.command === Command.DATETIME || this.command === Command.TIME) {
            this.time[this.command === Command.TIME ? 4 + this.byteIndex : this.byteIndex] = value;
        }
        this.byteIndex++;
        if (--this.remaining <= 0) {
            if (this.command === Command.DATETIME || this.command === Command.TIME) this.#setClock();
            this.command = -1;
        }
    }

    #readByte() {
        if (this.command === Command.CONTROL) return this.control;
        if (this.command === Command.DATETIME) return this.time[this.byteIndex];
        if (this.command === Command.TIME) return this.time[4 + this.byteIndex];
        return 0;
    }

    /** Copies the current time into the registers (BCD). */
    #latch() {
        const date = new Date(this.now() + this.offset * 1000);
        const hour = date.getUTCHours();
        this.time[0] = bcd(date.getUTCFullYear() % 100);
        this.time[1] = bcd(date.getUTCMonth() + 1);
        this.time[2] = bcd(date.getUTCDate());
        this.time[3] = bcd(date.getUTCDay());
        // Bit 7: PM.
        this.time[4] = bcd(this.control & 0x40 ? hour : hour % 12) | (hour >= 12 ? 0x80 : 0);
        this.time[5] = bcd(date.getUTCMinutes());
        this.time[6] = bcd(date.getUTCSeconds());
    }

    /** The game set the clock: keep the difference to the wall clock. */
    #setClock() {
        const t = this.time;
        let hour = fromBcd(t[4] & 0x3f);
        if (!(this.control & 0x40) && t[4] & 0x80) hour += 12;
        const set = Date.UTC(2000 + fromBcd(t[0]), fromBcd(t[1] & 0x1f) - 1, fromBcd(t[2] & 0x3f), hour,
            fromBcd(t[5] & 0x7f), fromBcd(t[6] & 0x7f));
        if (Number.isFinite(set)) this.offset = Math.round((set - this.now()) / 1000);
    }

    /** The clock's part of the saved game; empty unless the game changed it. */
    toSave() {
        if (this.offset === 0 && this.control === DEFAULT_CONTROL) return new Uint8Array(0);
        const out = new Uint8Array(16);
        const view = new DataView(out.buffer);
        view.setUint32(0, SAVE_MAGIC, true);
        view.setUint8(4, this.control);
        view.setFloat64(8, this.offset, true);
        return out;
    }

    /** @returns {boolean} whether `data` was the clock's block. */
    fromSave(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        if (data.length !== 16 || view.getUint32(0, true) !== SAVE_MAGIC) return false;
        this.control = view.getUint8(4);
        this.offset = view.getFloat64(8, true);
        return true;
    }
}
