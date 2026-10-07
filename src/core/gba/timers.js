const PRESCALERS = [1, 64, 256, 1024];
// Reads see the counter as it was this many cycles earlier (tuned against
// mGBA's suite).
const READ_DELAY = 2;

/**
 * The four 16-bit timers. Counters are worked out from the time they
 * started rather than ticked; an overflow is scheduled as an event only when
 * something depends on it (its interrupt, a cascaded timer, the sound
 * FIFOs).
 */
export class Timers {
  /**
   * @param {{ now: () => number, requestIrq: (bit: number, time: number) => void, onOverflow: (timer: number, time: number) => void,
   *   feedsSound: (timer: number) => boolean, onSchedule: (time: number) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.reload = new Uint16Array(4);
    this.control = new Uint16Array(4);
    // Counter value at `start` (cycles).
    this.startCounter = new Uint16Array(4);
    this.start = new Float64Array(4);
    this.due = new Float64Array(4).fill(Infinity);
    this.nextEvent = Infinity;
    this.reset();
  }

  reset() {
    this.reload.fill(0);
    this.control.fill(0);
    this.startCounter.fill(0);
    this.start.fill(0);
    this.due.fill(Infinity);
    this.nextEvent = Infinity;
  }

  sync(s) {
    s.bytes(this.reload);
    s.bytes(this.control);
    s.bytes(this.startCounter);
    s.bytes(this.start);
    if (s.reading) this.schedule();
  }

  #running(i) {
    return (this.control[i] & 0x80) !== 0 && !(i > 0 && this.control[i] & 4);
  }

  /** Current counter of timer i. */
  counter(i, now = this.hooks.now()) {
    if (!this.#running(i)) return this.startCounter[i];
    const prescale = PRESCALERS[this.control[i] & 3];
    const ticks = Math.floor((now - this.start[i]) / prescale);
    const first = 0x10000 - this.startCounter[i];
    if (ticks < first) return this.startCounter[i] + Math.max(0, ticks);
    const period = 0x10000 - this.reload[i];
    return this.reload[i] + ((ticks - first) % period);
  }

  read16(address) {
    const i = (address - 0x100) >> 2;
    return address & 2 ? this.control[i] : this.counter(i, this.hooks.now() - READ_DELAY);
  }

  write16(address, value) {
    const i = (address - 0x100) >> 2;
    const now = this.hooks.now();
    if (!(address & 2)) {
      // The new reload value applies from the next overflow.
      this.#rebase(i, now);
      this.reload[i] = value;
      this.schedule();
      return;
    }
    const old = this.control[i];
    this.#rebase(i, now);
    this.control[i] = value & 0xc7;
    const started = !(old & 0x80) && value & 0x80;
    if (started) this.startCounter[i] = this.reload[i];
    if (started || (value & 3) !== (old & 3)) {
      // The prescaler divides a clock shared by all timers: ticks fall on
      // multiples of it.
      const prescale = PRESCALERS[value & 3];
      this.start[i] = Math.floor(now / prescale) * prescale;
    }
    this.schedule();
  }

  /** Restarts the bookkeeping of timer i from now. */
  #rebase(i, now) {
    if (!this.#running(i)) return;
    const prescale = PRESCALERS[this.control[i] & 3];
    this.startCounter[i] = this.counter(i, now);
    // Keep the phase within the current prescaler tick.
    const elapsed = now - this.start[i];
    this.start[i] = now - (elapsed % prescale);
  }

  /** Whether an overflow of timer i matters to anything. */
  #watched(i) {
    if (this.control[i] & 0x40) return true;
    if (i < 3 && this.control[i + 1] & 0x80 && this.control[i + 1] & 4) return true;
    return i < 2 && this.hooks.feedsSound(i);
  }

  /** Recomputes when the next watched overflow happens. */
  schedule() {
    let next = Infinity;
    for (let i = 0; i < 4; i++) {
      this.due[i] = Infinity;
      if (!this.#running(i) || !this.#watched(i)) continue;
      const prescale = PRESCALERS[this.control[i] & 3];
      const now = this.hooks.now();
      const ticks = Math.max(0, Math.floor((now - this.start[i]) / prescale));
      const first = 0x10000 - this.startCounter[i];
      let ticksToOverflow;
      if (ticks < first) ticksToOverflow = first;
      else {
        const period = 0x10000 - this.reload[i];
        ticksToOverflow = first + (Math.floor((ticks - first) / period) + 1) * period;
      }
      this.due[i] = this.start[i] + ticksToOverflow * prescale;
      if (this.due[i] < next) next = this.due[i];
    }
    this.nextEvent = next;
    this.hooks.onSchedule(next);
  }

  /** Handles the overflows due by `now`. */
  event(now) {
    for (let i = 0; i < 4; i++) {
      while (this.due[i] <= now) {
        const time = this.due[i];
        // Restart from the reload value at the moment of overflow.
        this.startCounter[i] = this.reload[i];
        this.start[i] = time;
        this.#overflow(i, time);
        const prescale = PRESCALERS[this.control[i] & 3];
        this.due[i] = time + (0x10000 - this.reload[i]) * prescale;
      }
    }
    this.schedule();
  }

  #overflow(i, time) {
    if (this.control[i] & 0x40) this.hooks.requestIrq(3 + i, time);
    this.hooks.onOverflow(i, time);
    // Cascade: the next timer counts this one's overflows.
    const next = i + 1;
    if (next < 4 && this.control[next] & 0x80 && this.control[next] & 4) {
      if (this.startCounter[next] === 0xffff) {
        this.startCounter[next] = this.reload[next];
        this.#overflow(next, time);
      } else {
        this.startCounter[next]++;
      }
    }
  }
}
