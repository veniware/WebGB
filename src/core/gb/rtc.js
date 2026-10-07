const DAY = 86400;
// Size of the clock data appended to saved games (VBA-M/BGB/mGBA format).
export const RTC_SAVE_SIZE = 48;

/**
 * MBC3 real-time clock.
 *
 * Like the cartridge's own battery-powered crystal, it follows the wall
 * clock: it keeps running while the game is paused or closed, and fast
 * forward doesn't speed it up. The registers are separate counters, as on
 * the chip: out-of-range values (e.g. 63 seconds) count on and wrap without
 * carrying. They are kept as the values they had at `base` (a wall-clock
 * moment that starts a second), so the stored state doesn't change while
 * the clock runs; the current time is worked out when it is read.
 */
export class Rtc {
    /** @param {() => number} now Wall clock in milliseconds. */
    constructor(now = Date.now) {
        this.now = now;
        // Seconds, minutes, hours, days (9 bits) at `base`, and the day carry flag.
        this.regs = new Uint16Array(4);
        this.carry = false;
        this.base = now();
        this.halted = false;
        // While halted: milliseconds into the second when the clock stopped.
        this.haltedMs = 0;
        this.latched = new Uint8Array(5);
        // Cache of the last time worked out: [ticks since base, s, m, h, d, carry].
        this.cache = [-1, 0, 0, 0, 0, 0];
    }

    sync(s) {
        s.bytes(this.regs);
        this.carry = s.bool(this.carry);
        this.base = s.f64(this.base);
        this.halted = s.bool(this.halted);
        this.haltedMs = s.u16(this.haltedMs);
        s.bytes(this.latched);
        this.cache[0] = -1;
    }

    /** Copies the counters into the readable registers (game writes 0 then 1 to 6000-7FFF). */
    latch() {
        const [s, m, h, d, carry] = this.#current();
        this.latched.set([s, m, h, d & 0xff, (d >> 8) | (this.halted ? 0x40 : 0) | (carry ? 0x80 : 0)]);
    }

    /** @param {number} register 0x08-0x0C */
    read(register) {
        return this.latched[register - 8];
    }

    write(register, value) {
        const now = this.now();
        // Bring the counters up to now, keeping the time into the current second.
        const [s, m, h, d, carry] = this.#current();
        if (!this.halted) this.base += Math.floor((now - this.base) / 1000) * 1000;
        this.regs.set([s, m, h, d]);
        this.carry = carry;
        switch (register) {
            case 8:
                this.regs[0] = value & 0x3f;
                // Writing the seconds restarts the sub-second divider.
                this.base = now;
                this.haltedMs = 0;
                break;
            case 9: this.regs[1] = value & 0x3f; break;
            case 10: this.regs[2] = value & 0x1f; break;
            case 11: this.regs[3] = (this.regs[3] & 0x100) | value; break;
            default: {
                this.regs[3] = (this.regs[3] & 0xff) | ((value & 1) << 8);
                this.carry = (value & 0x80) !== 0;
                const halt = (value & 0x40) !== 0;
                // Stopping and restarting keeps the time into the current second.
                if (halt && !this.halted) this.haltedMs = now - this.base;
                else if (!halt && this.halted) this.base = now - this.haltedMs;
                this.halted = halt;
            }
        }
        this.cache[0] = -1;
        this.latched[register - 8] = value & [0x3f, 0x3f, 0x1f, 0xff, 0xc1][register - 8];
    }

    /**
     * Clock data for the saved game: the counters at `base` and that time
     * (Unix seconds); 0 while halted.
     */
    toSave() {
        const data = new Uint8Array(RTC_SAVE_SIZE);
        const view = new DataView(data.buffer);
        const [s, m, h, d] = this.regs;
        const control = (d >> 8) | (this.halted ? 0x40 : 0) | (this.carry ? 0x80 : 0);
        [s, m, h, d & 0xff, control].forEach((value, i) => view.setUint32(i * 4, value, true));
        this.latched.forEach((value, i) => view.setUint32(20 + i * 4, value, true));
        const timestamp = this.halted ? 0 : Math.floor(this.base / 1000);
        view.setUint32(40, timestamp >>> 0, true);
        view.setUint32(44, Math.floor(timestamp / 2 ** 32), true);
        return data;
    }

    /** Loads clock data saved by this or another emulator (48 or 44 bytes). */
    fromSave(data) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const reg = (i) => view.getUint32(i * 4, true) & 0xff;
        const control = reg(4);
        this.regs.set([reg(0) & 0x3f, reg(1) & 0x3f, reg(2) & 0x1f, reg(3) | ((control & 1) << 8)]);
        this.halted = (control & 0x40) !== 0;
        this.carry = (control & 0x80) !== 0;
        this.haltedMs = 0;
        let timestamp = view.getUint32(40, true);
        if (data.length >= 48) timestamp += view.getUint32(44, true) * 2 ** 32;
        // A timestamp in the future (clock changed) shouldn't run the clock backwards.
        this.base = Math.min(timestamp * 1000, this.now());
        for (let i = 0; i < 5; i++) this.latched[i] = reg(5 + i);
        this.cache[0] = -1;
    }

    /** The counters now: [seconds, minutes, hours, days, carry]. */
    #current() {
        const ticks = this.halted ? 0 : Math.max(0, Math.floor((this.now() - this.base) / 1000));
        const cache = this.cache;
        if (cache[0] !== ticks) {
            const [s, m, h, d, carry] = advance(this.regs, this.carry, ticks);
            cache[0] = ticks;
            cache[1] = s;
            cache[2] = m;
            cache[3] = h;
            cache[4] = d;
            cache[5] = carry ? 1 : 0;
        }
        return [cache[1], cache[2], cache[3], cache[4], cache[5] === 1];
    }
}

/** The counters `ticks` seconds later. */
function advance([s, m, h, d], carry, ticks) {
    // Out-of-range values count one second at a time until they wrap (without carrying).
    while (ticks > 0 && (s >= 60 || m >= 60 || h >= 24)) {
        ticks--;
        s = (s + 1) & 0x3f;
        if (s !== 60) continue;
        s = 0;
        m = (m + 1) & 0x3f;
        if (m !== 60) continue;
        m = 0;
        h = (h + 1) & 0x1f;
        if (h !== 24) continue;
        h = 0;
        if (++d > 0x1ff) {
            d = 0;
            carry = true;
        }
    }
    if (ticks > 0) {
        const total = s + m * 60 + h * 3600 + d * DAY + ticks;
        s = total % 60;
        m = Math.floor(total / 60) % 60;
        h = Math.floor(total / 3600) % 24;
        d = Math.floor(total / DAY);
        if (d > 0x1ff) {
            d %= 0x200;
            carry = true;
        }
    }
    return [s, m, h, d, carry];
}
