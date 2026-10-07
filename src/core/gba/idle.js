// Loops at most this long (bytes from the branch back to the loop's start)
// are checked: idle loops are a few instructions.
const SPAN = 64;

/**
 * Idle-loop skipping. Many games wait for an interrupt or a register by
 * polling memory in a tight loop instead of halting; emulating every pass
 * costs as much as running real code. At each short backward branch the CPU
 * is compared with the previous pass through the same loop: if that pass
 * wrote nothing, read nothing that changes on its own (timers, sound
 * registers, EEPROM), crossed no event and ended with the same registers,
 * the machine is back in the same state, so every following pass will be
 * the same until the next event. Whole passes are then skipped up to it,
 * which leaves the timing exactly as if they had run.
 */
export class IdleLoops {
  enabled = true;
  /** Cycles skipped so far (for tests and performance numbers). */
  skipped = 0;
  #target = -1;
  #start = 0;
  #writes = 0;
  #volatile = 0;
  #events = 0;
  #flags = 0;
  #regs = new Int32Array(15);

  /**
   * @param {import('./bus.js').Bus} bus
   * @param {{ eventTime: number, eventCount: number }} machine  When the next event is due; events so far.
   */
  constructor(bus, machine) {
    this.bus = bus;
    this.machine = machine;
  }

  /** Whether a branch from `pc` (the instruction after it) to `target` closes a loop worth checking. */
  static isLoop(pc, target) {
    const back = pc - target;
    return back > 0 && back <= SPAN;
  }

  /** A short loop's branch back to `target`, about to be taken. */
  onLoop(cpu, target) {
    if (!this.enabled) return;
    const { bus, machine } = this;
    const regs = this.#regs;
    const r = cpu.r;
    const flags = cpu.n | (cpu.z << 1) | (cpu.c << 2) | (cpu.v << 3) | (cpu.mode << 4) | (cpu.irqDisable ? 0x200 : 0);
    let same = target === this.#target && bus.writes === this.#writes && bus.volatileReads === this.#volatile &&
      machine.eventCount === this.#events && flags === this.#flags;
    for (let i = 0; i < 15; i++) {
      if (regs[i] !== r[i]) {
        same = false;
        regs[i] = r[i];
      }
    }
    if (same) {
      // A pass that changed nothing: the next ones will be the same.
      const pass = bus.cycles - this.#start;
      const passes = Math.floor((machine.eventTime - bus.cycles) / pass);
      if (passes > 0) {
        bus.skip(passes * pass);
        this.skipped += passes * pass;
      }
    }
    this.#target = target;
    this.#writes = bus.writes;
    this.#volatile = bus.volatileReads;
    this.#events = machine.eventCount;
    this.#flags = flags;
    this.#start = bus.cycles;
  }
}
