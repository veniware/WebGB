const DAY = 86400;
// The day counter has 9 bits; past that it wraps and sets the carry flag.
const MAX_SECONDS = 512 * DAY;
// Size of the clock data appended to saved games (VBA-M/BGB/mGBA format).
export const RTC_SAVE_SIZE = 48;

/**
 * MBC3 real-time clock.
 *
 * Like the cartridge's own battery-powered crystal, it follows the wall
 * clock: it keeps running while the game is paused or closed, and fast
 * forward doesn't speed it up. The time is stored as the wall-clock moment
 * the counter was zero (`base`), so it doesn't change while running.
 */
export class Rtc {
  /** @param {() => number} now Wall clock in milliseconds. */
  constructor(now = Date.now) {
    this.now = now;
    this.base = now();
    this.halted = false;
    // Counter value (seconds) while halted.
    this.haltedSeconds = 0;
    this.carry = false;
    this.latched = new Uint8Array(5);
  }

  sync(s) {
    this.base = s.f64(this.base);
    this.halted = s.bool(this.halted);
    this.haltedSeconds = s.f64(this.haltedSeconds);
    this.carry = s.bool(this.carry);
    s.bytes(this.latched);
  }

  /** Copies the counter into the readable registers (game writes 0 then 1 to 6000-7FFF). */
  latch() {
    const t = this.#seconds();
    const days = Math.floor(t / DAY);
    this.latched[0] = t % 60;
    this.latched[1] = Math.floor(t / 60) % 60;
    this.latched[2] = Math.floor(t / 3600) % 24;
    this.latched[3] = days & 0xff;
    this.latched[4] = (days >> 8) | (this.halted ? 0x40 : 0) | (this.carry ? 0x80 : 0);
  }

  /** @param {number} register 0x08-0x0C */
  read(register) {
    return this.latched[register - 8];
  }

  write(register, value) {
    const now = this.now();
    let t = this.#seconds();
    let seconds = t % 60;
    let minutes = Math.floor(t / 60) % 60;
    let hours = Math.floor(t / 3600) % 24;
    let days = Math.floor(t / DAY);
    // Writing the seconds also resets the sub-second divider.
    let fraction = register === 8 || this.halted ? 0 : (now - this.base) % 1000;
    switch (register) {
      case 8: seconds = value & 0x3f; break;
      case 9: minutes = value & 0x3f; break;
      case 10: hours = value & 0x1f; break;
      case 11: days = (days & 0x100) | value; break;
      default:
        days = (days & 0xff) | ((value & 1) << 8);
        this.carry = (value & 0x80) !== 0;
        this.halted = (value & 0x40) !== 0;
        fraction = 0;
    }
    t = seconds + minutes * 60 + hours * 3600 + days * DAY;
    this.haltedSeconds = t;
    this.base = now - t * 1000 - fraction;
    this.latched[register - 8] = value;
  }

  /** Clock data for the saved game: the counter at time `base`, i.e. zero, and that time. */
  toSave() {
    const data = new Uint8Array(RTC_SAVE_SIZE);
    const view = new DataView(data.buffer);
    this.#seconds();
    let t = 0;
    let timestamp = Math.floor(this.base / 1000);
    if (this.halted) {
      t = this.haltedSeconds;
      timestamp = 0;
    }
    const days = Math.floor(t / DAY);
    const regs = [t % 60, Math.floor(t / 60) % 60, Math.floor(t / 3600) % 24, days & 0xff,
      (days >> 8) | (this.halted ? 0x40 : 0) | (this.carry ? 0x80 : 0)];
    regs.forEach((value, i) => {
      view.setUint32(i * 4, value, true);
      view.setUint32(20 + i * 4, value, true);
    });
    view.setUint32(40, timestamp >>> 0, true);
    view.setUint32(44, Math.floor(timestamp / 2 ** 32), true);
    return data;
  }

  /** Loads clock data saved by this or another emulator (48 or 44 bytes). */
  fromSave(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const reg = (i) => view.getUint32(i * 4, true) & 0xff;
    const dh = reg(4);
    const t = (reg(0) & 0x3f) + (reg(1) & 0x3f) * 60 + (reg(2) & 0x1f) * 3600 + (reg(3) | ((dh & 1) << 8)) * DAY;
    let timestamp = view.getUint32(40, true);
    if (data.length >= 48) timestamp += view.getUint32(44, true) * 2 ** 32;
    this.halted = (dh & 0x40) !== 0;
    this.carry = (dh & 0x80) !== 0;
    this.haltedSeconds = t;
    this.base = (timestamp - t) * 1000;
    // A timestamp in the future (clock changed) shouldn't run the counter backwards.
    if (this.base > this.now() - t * 1000) this.base = this.now() - t * 1000;
    for (let i = 0; i < 5; i++) this.latched[i] = reg(5 + i);
  }

  /** Current counter in seconds; wraps the day counter into the carry flag. */
  #seconds() {
    if (this.halted) {
      if (this.haltedSeconds >= MAX_SECONDS) {
        this.haltedSeconds %= MAX_SECONDS;
        this.carry = true;
      }
      return this.haltedSeconds;
    }
    let t = Math.floor((this.now() - this.base) / 1000);
    if (t >= MAX_SECONDS) {
      const wraps = Math.floor(t / MAX_SECONDS);
      this.base += wraps * MAX_SECONDS * 1000;
      t -= wraps * MAX_SECONDS;
      this.carry = true;
    }
    return Math.max(0, t);
  }
}
