import { renamed } from '../memory.js';
import { StateReader, StateWriter } from '../state.js';
import { FRAME_DOTS, SCREEN_HEIGHT, SCREEN_WIDTH } from './constants.js';

const STATE_MAGIC = 0x4b4e494c; // "LINK"
// Dots each machine runs before the other catches up; short enough for the
// fastest (CGB double-speed) serial transfers to see each other in time.
const SLICE_DOTS = 32;
// Player 2's buttons in the input bitmask.
export const PLAYER_2_SHIFT = 16;

/**
 * Two Game Boys connected by a link cable (and their infrared ports),
 * presented to the host as one core: both screens side by side (or
 * stacked), both sounds mixed, player 2's buttons in the upper 16 bits.
 */
export class LinkedGameBoys {
  id = 'gb-link';
  version = 1;
  players = 2;

  /**
   * @param {import('./gameboy.js').GameBoy} first Usually the game already running.
   * @param {import('./gameboy.js').GameBoy} second
   * @param {{ vertical?: boolean }} [options] Stack the screens instead of side by side.
   */
  constructor(first, second, { vertical = false } = {}) {
    this.machines = [first, second];
    this.fps = first.fps;
    this.sampleRate = first.sampleRate;
    this.vertical = vertical;
    this.width = vertical ? SCREEN_WIDTH : SCREEN_WIDTH * 2;
    this.height = vertical ? SCREEN_HEIGHT * 2 : SCREEN_HEIGHT;
    this.frame = new Uint8ClampedArray(this.width * this.height * 4);
    this.pixels = new Uint32Array(this.frame.buffer);
    this.audio = new Float32Array(8192);
    this.audioLength = 0;
    first.serial.link = second.serial;
    second.serial.link = first.serial;
  }

  /** Disconnects; the machines keep running on their own. */
  unlink() {
    for (const gb of this.machines) gb.serial.link = null;
  }

  reset() {
    for (const gb of this.machines) gb.reset();
  }

  configure(options) {
    for (const gb of this.machines) gb.configure(options);
  }

  setInput(buttons) {
    this.machines[0].setInput(buttons & 0xffff);
    this.machines[1].setInput(buttons >>> PLAYER_2_SHIFT);
  }

  runFrame() {
    const [a, b] = this.machines;
    a.beginFrame();
    b.beginFrame();
    for (let dots = 0; dots < FRAME_DOTS; dots += SLICE_DOTS) {
      a.setInfrared(b.irLight);
      b.setInfrared(a.irLight);
      a.runDots(SLICE_DOTS);
      b.runDots(SLICE_DOTS);
    }
    a.endFrame(false);
    b.endFrame(false);
    this.#compose();
    this.#mix();
  }

  #compose() {
    const { pixels, vertical, width } = this;
    this.machines.forEach((gb, player) => {
      const source = new Uint32Array(gb.getScreenBuffer().buffer);
      for (let y = 0; y < SCREEN_HEIGHT; y++) {
        const row = source.subarray(y * SCREEN_WIDTH, (y + 1) * SCREEN_WIDTH);
        const offset = vertical ? (player * SCREEN_HEIGHT + y) * width : y * width + player * SCREEN_WIDTH;
        pixels.set(row, offset);
      }
    });
  }

  #mix() {
    const first = this.machines[0].getAudioSamples();
    const second = this.machines[1].getAudioSamples();
    const length = Math.min(first.length, second.length, this.audio.length);
    for (let i = 0; i < length; i++) this.audio[i] = (first[i] + second[i]) * 0.5;
    this.audioLength = length;
  }

  getFrameBuffer() {
    return this.frame;
  }

  getAudioSamples() {
    return this.audio.subarray(0, this.audioLength);
  }

  getSaveData(player = 0) {
    return this.machines[player].getSaveData();
  }

  getSaveWrites(player = 0) {
    return this.machines[player].getSaveWrites();
  }

  getMemoryRegions() {
    return this.machines.flatMap((gb, player) => renamed(gb.getMemoryRegions(), `Player ${player + 1}: `));
  }

  screenshot(player = 0) {
    return this.machines[player].screenshot();
  }

  loadSaveData(data, player = 0) {
    this.machines[player].loadSaveData(data);
  }

  getRumble() {
    return Math.max(this.machines[0].getRumble(), this.machines[1].getRumble());
  }

  saveState() {
    const s = new StateWriter();
    s.u32(STATE_MAGIC);
    for (const gb of this.machines) {
      const state = gb.saveState();
      s.u32(state.length);
      s.bytes(state);
    }
    return s.finish();
  }

  loadState(data) {
    const s = new StateReader(data);
    if (s.u32() !== STATE_MAGIC) throw new Error('This snapshot is not of linked games.');
    const states = this.machines.map(() => {
      const state = new Uint8Array(s.u32());
      s.bytes(state);
      return state;
    });
    this.machines.forEach((gb, i) => gb.loadState(states[i]));
  }
}
