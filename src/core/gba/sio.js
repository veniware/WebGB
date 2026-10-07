// SIO modes, from RCNT bits 14-15 and SIOCNT bits 12-13.
const Mode = { NORMAL8: 0, NORMAL32: 1, MULTI: 2, UART: 3, GPIO: 4, JOYBUS: 5 };

// Pin levels (RCNT bits 0-3) per mode with nothing connected, as measured
// (mGBA's suite).
const PINS = [0x5, 0x5, 0xf, 0xf, 0, 0xc];
const START_DELAY = 25;
// A multiplayer transfer between two GBAs, by baud rate (9600, 38400, 57600
// and 115200 bps), in cycles (mGBA's figures).
const MULTI_CYCLES = [73003, 18251, 12167, 6075];
// UART: cycles per bit at each baud rate (16.78 MHz / bps).
const UART_BIT_CYCLES = [1748, 437, 291, 146];

/**
 * The serial port. With nothing plugged in, its registers behave as on
 * hardware for each mode, and a Normal-mode transfer on the internal clock
 * completes (receiving all ones) and raises its interrupt; multiplayer and
 * external-clock transfers never finish.
 *
 * With a link cable (`link`: the other machine's port, see link.js), the
 * parent (player 0) runs multiplayer transfers for both, and in Normal mode
 * the side on the internal clock swaps data with the other side if that one
 * waits for it (external clock, started). A transfer is shared by the two
 * ports: each sender's word is taken when the transfer starts (the parent's,
 * or the master's) or when it first ends on either machine (the other one's);
 * each machine finishes it on its own clock. The machines run in turn, so
 * one can be a little behind: a transfer it hasn't finished yet is finished
 * before the next one starts, and until then it doesn't look ready.
 *
 * Linked UART: bytes written to SIODATA8 go out one at a time at the baud
 * rate (start, data, optional parity and stop bits) into the partner's
 * receive buffer, if its receiver is on. With the FIFO enabled each side
 * buffers 4 bytes, else 1. The interrupt fires when a byte has gone out and
 * when one arrives. CTS and parity errors aren't modeled.
 */
export class Sio {
  /** The other machine's port (link cable), or null. */
  link = null;
  /** 0: parent (the cable's purple end), 1: child. */
  player = 0;
  /** The partner's clock minus this machine's clock. */
  offset = 0;

  /**
   * @param {{ now: () => number, requestIrq: (bit: number, time: number) => void,
   *   onSchedule: (time: number) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    // 0x120-0x126: SIODATA32 (low, high), or SIOMULTI0-3.
    this.data = new Uint16Array(4);
    this.reset();
  }

  reset() {
    this.data.fill(0);
    this.siocnt = 0;
    this.data8 = 0;
    this.rcnt = 0;
    this.joycnt = 0;
    this.joystat = 0;
    this.nextEvent = Infinity;
    // The linked transfer in progress: { words: [player 0's or the master's, the other's] }.
    this.transfer = null;
    // Linked UART: bytes waiting to go out (the first is on its way) and received.
    this.uartOut = [];
    this.uartIn = [];
  }

  sync(s) {
    s.bytes(this.data.subarray(0, 2));
    this.siocnt = s.u16(this.siocnt);
    this.data8 = s.u16(this.data8);
    this.rcnt = s.u16(this.rcnt);
    this.joycnt = s.u16(this.joycnt);
    this.joystat = s.u16(this.joystat);
    this.nextEvent = s.f64(this.nextEvent);
    // Only linked machines (whose states the host doesn't keep) have more.
    if (this.link) {
      s.bytes(this.data.subarray(2));
      const words = this.transfer?.words ?? [-1, -1];
      if (s.bool(this.transfer !== null)) this.transfer = { words: [s.f64(words[0]), s.f64(words[1])] };
      else this.transfer = null;
      for (const buffer of [this.uartOut, this.uartIn]) {
        const length = s.u8(buffer.length);
        for (let i = 0; i < length; i++) buffer[i] = s.u8(buffer[i]);
        buffer.length = length;
      }
    }
  }

  get mode() {
    if (this.rcnt & 0x8000) return this.rcnt & 0x4000 ? Mode.JOYBUS : Mode.GPIO;
    return (this.siocnt >>> 12) & 3;
  }

  read16(address) {
    switch (address) {
      case 0x120: case 0x122: case 0x124: case 0x126: return this.data[(address - 0x120) >> 1];
      case 0x128: return this.link ? this.#linkedControl() : this.siocnt;
      case 0x12a:
        if (this.link && this.mode === Mode.UART && this.uartIn.length) this.data8 = this.uartIn.shift();
        return this.data8;
      case 0x134: {
        const mode = this.mode;
        return (this.rcnt & 0xc1f0) | (mode === Mode.GPIO ? this.rcnt & 0xf : PINS[mode]);
      }
      case 0x140: return this.joycnt;
      case 0x158: return this.joystat;
      default: return 0; // JOY_RECV/JOY_TRANS: nothing on the other end
    }
  }

  write16(address, value) {
    switch (address) {
      case 0x120: case 0x122:
        if (this.mode === Mode.NORMAL32) this.data[(address - 0x120) >> 1] = value;
        break;
      case 0x128: this.#writeControl(value); break;
      case 0x12a:
        if (this.mode !== Mode.UART) this.data8 = value;
        else if (this.link) this.#uartSend(value & 0xff);
        break;
      case 0x134: this.rcnt = value & 0xc1ff; break;
      case 0x140: this.joycnt = (value & 0x40) | (this.joycnt & ~value & 7); break;
      case 0x158: this.joystat = (this.joystat & ~0x30) | (value & 0x30); break;
    }
  }

  /** SIOCNT's status bits with a partner: what its terminals show. */
  #linkedControl() {
    const partner = this.link;
    const mode = this.mode;
    if (mode === Mode.MULTI) {
      // SI: low for the parent; SD: high while both are in multiplayer mode.
      return (this.siocnt & ~0x0c) | (this.player ? 4 : 0) | (partner.mode === Mode.MULTI ? 8 : 0);
    }
    if (mode === Mode.NORMAL8 || mode === Mode.NORMAL32) {
      // SI is the partner's SO: low while it waits for a transfer, else its
      // idle level; high while it is still finishing one on its clock.
      const finishing = partner.transfer !== null && partner.nextEvent !== Infinity;
      const so = finishing ? 1 : partner.siocnt & 0x80 ? 0 : partner.siocnt & 8;
      return (this.siocnt & ~4) | (so ? 4 : 0);
    }
    if (mode === Mode.UART) {
      // Send buffer full, receive buffer empty.
      const full = this.uartOut.length >= this.#uartCapacity() ? 0x10 : 0;
      return (this.siocnt & ~0x70) | full | (this.uartIn.length ? 0 : 0x20);
    }
    return this.siocnt;
  }

  #uartCapacity() {
    return this.siocnt & 0x100 ? 4 : 1;
  }

  #uartSend(byte) {
    if (!(this.siocnt & 0x400) || this.uartOut.length >= this.#uartCapacity()) return;
    this.uartOut.push(byte);
    if (this.uartOut.length === 1) this.#uartNext(this.hooks.now());
  }

  /** Puts the next byte on the line: start bit, 7 or 8 data bits, parity, stop bit. */
  #uartNext(from) {
    const bits = 2 + (this.siocnt & 0x80 ? 8 : 7) + (this.siocnt & 0x200 ? 1 : 0);
    this.nextEvent = from + bits * UART_BIT_CYCLES[this.siocnt & 3];
    this.hooks.onSchedule(this.nextEvent);
  }

  /** A byte arrives from the partner at `time` (this machine's clock). */
  #uartReceive(byte, time) {
    if (this.mode !== Mode.UART || !(this.siocnt & 0x800) || this.uartIn.length >= this.#uartCapacity()) return;
    this.uartIn.push(byte & (this.siocnt & 0x80 ? 0xff : 0x7f));
    if (this.siocnt & 0x4000) this.hooks.requestIrq(7, time);
  }

  #writeControl(value) {
    const busy = this.siocnt & 0x80;
    const mode = (value >>> 12) & 3;
    if (this.link && this.rcnt < 0x8000 && mode === Mode.MULTI) {
      // Linked multiplayer: the ID, error and busy bits are the hardware's.
      const status = this.mode === Mode.MULTI ? this.siocnt & 0xf0 : 0;
      this.siocnt = (value & 0x7f03) | status;
      if (value & 0x80 && !busy && this.player === 0) this.#startMulti();
      return;
    }
    if (this.link && this.rcnt < 0x8000 && mode === Mode.UART) {
      // Linked UART: the status bits come from the buffers; turning the FIFO off empties them.
      if (!(value & 0x100)) {
        this.uartOut.length = Math.min(this.uartOut.length, 1);
        this.uartIn.length = Math.min(this.uartIn.length, 1);
      }
      this.siocnt = value & 0x7f8f;
      return;
    }
    this.siocnt = value & 0x7f8f;
    // Status bits: in multiplayer, a child (SI high) that's ready; in UART,
    // an empty receive FIFO.
    if (this.mode === Mode.MULTI) this.siocnt = (this.siocnt & ~0x70) | 0x0c;
    else if (this.mode === Mode.UART) this.siocnt = (this.siocnt & ~0x70) | 0x20;
    if (!(value & 0x80)) {
      this.nextEvent = Infinity;
      this.transfer = null;
    } else if (!busy && (this.mode === Mode.NORMAL8 || this.mode === Mode.NORMAL32) && value & 1) {
      // Internal clock: 256 KHz or 2 MHz, after a fixed delay (as measured).
      const bits = this.mode === Mode.NORMAL32 ? 32 : 8;
      const end = this.hooks.now() + START_DELAY + bits * (value & 2 ? 8 : 64);
      const partner = this.link;
      if (partner && partner.#waitsForClock(this.mode)) {
        this.transfer = { words: [this.#normalWord(), -1] };
        partner.#begin(this.transfer, end + this.offset);
      }
      this.#begin(this.transfer, end);
    }
  }

  /** The parent starts a multiplayer transfer for both machines. */
  #startMulti() {
    const end = this.hooks.now() + START_DELAY + MULTI_CYCLES[this.siocnt & 3];
    this.transfer = { words: [this.data8, -1] };
    const partner = this.link;
    if (partner.mode === Mode.MULTI) partner.#begin(this.transfer, end + this.offset);
    else this.transfer.words[1] = 0xffff;
    this.#begin(this.transfer, end);
  }

  #begin(transfer, end) {
    // The partner's previous transfer, if its machine hasn't got to its end yet.
    if (this.transfer && this.nextEvent !== Infinity) this.event(this.nextEvent);
    this.transfer = transfer;
    this.siocnt |= 0x80;
    this.nextEvent = end;
    this.hooks.onSchedule(end);
  }

  /** In Normal mode on the external clock and started: takes part in the partner's transfer. */
  #waitsForClock(mode) {
    return this.mode === mode && (this.siocnt & 0x81) === 0x80 && this.nextEvent === Infinity;
  }

  /** The word this side sends in Normal mode (unsigned; -1 means not taken yet). */
  #normalWord() {
    return this.mode === Mode.NORMAL32 ? (this.data[0] | (this.data[1] << 16)) >>> 0 : this.data8 & 0xff;
  }

  /** The transfer is done (or, in linked UART, a byte has gone out). */
  event(now) {
    const time = this.nextEvent;
    this.nextEvent = Infinity;
    if (now < time) return;
    if (this.uartOut.length) {
      this.link?.#uartReceive(this.uartOut.shift(), time + this.offset);
      if (this.uartOut.length) this.#uartNext(time);
      if (this.siocnt & 0x4000) this.hooks.requestIrq(7, time);
      return;
    }
    this.siocnt &= ~0x80;
    const transfer = this.transfer;
    this.transfer = null;
    const mode = this.mode;
    if (transfer && mode === Mode.MULTI) {
      // The child's word, if the parent's machine didn't take it yet.
      if (transfer.words[1] === -1) transfer.words[1] = (this.player ? this : this.link).data8;
      this.data[0] = transfer.words[0];
      this.data[1] = transfer.words[1];
      this.data[2] = 0xffff;
      this.data[3] = 0xffff;
      this.siocnt = (this.siocnt & ~0x70) | (this.player << 4);
    } else if (transfer) {
      // Normal mode: the master (internal clock) and the slave swap words.
      const master = (this.siocnt & 1) !== 0;
      if (transfer.words[1] === -1) transfer.words[1] = (master ? this.link : this).#normalWord();
      const word = master ? transfer.words[1] : transfer.words[0];
      if (mode === Mode.NORMAL32) {
        this.data[0] = word & 0xffff;
        this.data[1] = word >>> 16;
      } else {
        this.data8 = (this.data8 & 0xff00) | (word & 0xff);
      }
    } else if (mode === Mode.NORMAL32) {
      this.data.fill(0xffff, 0, 2);
    } else {
      this.data8 |= 0xff;
    }
    if (this.siocnt & 0x4000) this.hooks.requestIrq(7, time);
  }
}
