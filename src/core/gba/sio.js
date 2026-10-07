// SIO modes, from RCNT bits 14-15 and SIOCNT bits 12-13.
const Mode = { NORMAL8: 0, NORMAL32: 1, MULTI: 2, UART: 3, GPIO: 4, JOYBUS: 5 };

// Pin levels (RCNT bits 0-3) per mode with nothing connected, as measured
// (mGBA's suite).
const PINS = [0x5, 0x5, 0xf, 0xf, 0, 0xc];
const START_DELAY = 25;

/**
 * The serial port with nothing plugged in: its registers behave as on
 * hardware for each mode, and a Normal-mode transfer on the internal clock
 * completes (receiving all ones) and raises its interrupt. Multiplayer and
 * external-clock transfers never finish, as without a partner.
 */
export class Sio {
  /**
   * @param {{ now: () => number, requestIrq: (bit: number, time: number) => void,
   *   onSchedule: (time: number) => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.data32 = new Uint16Array(2);
    this.reset();
  }

  reset() {
    this.data32.fill(0);
    this.siocnt = 0;
    this.data8 = 0;
    this.rcnt = 0;
    this.joycnt = 0;
    this.joystat = 0;
    this.nextEvent = Infinity;
  }

  sync(s) {
    s.bytes(this.data32);
    this.siocnt = s.u16(this.siocnt);
    this.data8 = s.u16(this.data8);
    this.rcnt = s.u16(this.rcnt);
    this.joycnt = s.u16(this.joycnt);
    this.joystat = s.u16(this.joystat);
    this.nextEvent = s.f64(this.nextEvent);
  }

  get mode() {
    if (this.rcnt & 0x8000) return this.rcnt & 0x4000 ? Mode.JOYBUS : Mode.GPIO;
    return (this.siocnt >>> 12) & 3;
  }

  read16(address) {
    switch (address) {
      case 0x120: case 0x122: return this.data32[(address - 0x120) >> 1];
      case 0x124: case 0x126: return 0;
      case 0x128: return this.siocnt;
      case 0x12a: return this.data8;
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
        if (this.mode === Mode.NORMAL32) this.data32[(address - 0x120) >> 1] = value;
        break;
      case 0x128: this.#writeControl(value); break;
      case 0x12a: if (this.mode !== Mode.UART) this.data8 = value; break;
      case 0x134: this.rcnt = value & 0xc1ff; break;
      case 0x140: this.joycnt = (value & 0x40) | (this.joycnt & ~value & 7); break;
      case 0x158: this.joystat = (this.joystat & ~0x30) | (value & 0x30); break;
    }
  }

  #writeControl(value) {
    const busy = this.siocnt & 0x80;
    this.siocnt = value & 0x7f8f;
    const mode = this.mode;
    // Status bits: in multiplayer, a child (SI high) that's ready; in UART,
    // an empty receive FIFO.
    if (mode === Mode.MULTI) this.siocnt = (this.siocnt & ~0x70) | 0x0c;
    else if (mode === Mode.UART) this.siocnt = (this.siocnt & ~0x70) | 0x20;
    if (!(value & 0x80)) {
      this.nextEvent = Infinity;
    } else if (!busy && (mode === Mode.NORMAL8 || mode === Mode.NORMAL32) && value & 1) {
      // Internal clock: 256 KHz or 2 MHz, after a fixed delay (as measured).
      const bits = mode === Mode.NORMAL32 ? 32 : 8;
      this.nextEvent = this.hooks.now() + START_DELAY + bits * (value & 2 ? 8 : 64);
      this.hooks.onSchedule(this.nextEvent);
    }
  }

  /** The transfer is done. */
  event(now) {
    const time = this.nextEvent;
    this.nextEvent = Infinity;
    if (now < time) return;
    this.siocnt &= ~0x80;
    if (this.mode === Mode.NORMAL32) this.data32.fill(0xffff);
    else this.data8 |= 0xff;
    if (this.siocnt & 0x4000) this.hooks.requestIrq(7, time);
  }
}
