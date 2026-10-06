import { Button, BUTTON_NAMES } from '../buttons.js';

const SIZES = { gb: [160, 144], gbc: [160, 144], gba: [240, 160] };

// One note per button, in Button bit order (A, B, Select, Start, Right, Left, Up, Down, R, L).
const NOTES = [523.25, 440, 261.63, 329.63, 392, 349.23, 587.33, 293.66, 659.25, 698.46];
const VOLUME = 0.06;

const rgb = (r, g, b) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
const BACKGROUND = rgb(24, 26, 32);
const BARS = [
  rgb(255, 255, 255), rgb(255, 255, 0), rgb(0, 255, 255), rgb(0, 255, 0),
  rgb(255, 0, 255), rgb(255, 0, 0), rgb(0, 0, 255), rgb(0, 0, 0),
];
const DITHER_DARK = rgb(48, 98, 48);
const DITHER_LIGHT = rgb(139, 172, 15);
const STRIPE_A = rgb(40, 60, 200);
const STRIPE_B = rgb(230, 230, 240);
const DISK = rgb(240, 120, 40);
const MOVER = rgb(255, 255, 255);
const BUTTON_OFF = rgb(60, 64, 72);
const BUTTON_ON = rgb(110, 168, 254);
const COUNTER_ON = rgb(80, 220, 120);
const STATE_SIZE = 2 + NOTES.length + 2;

export function createTestCore(_rom, info) {
  return new TestCore(info.system);
}

/**
 * Stand-in core that exercises the frontend (filters, zoom, input, audio,
 * speed, snapshots) until real cores exist. Draws color bars, dither
 * patterns, a disk for edge smoothing, a mover that shows emulation speed
 * and one indicator per button. Each held button plays a square-wave note.
 *
 * It also has 4 bytes of battery RAM holding a counter of Start presses,
 * drawn in binary above the button row, to exercise saved games.
 */
export class TestCore {
  id = 'test';
  version = 2;
  fps = 59.7275;
  sampleRate = 48000;

  constructor(system = 'gb') {
    [this.width, this.height] = SIZES[system] ?? SIZES.gb;
    this.frame = new Uint8ClampedArray(this.width * this.height * 4);
    this.pixels = new Uint32Array(this.frame.buffer);
    this.audio = new Float32Array(Math.ceil(this.sampleRate / this.fps + 1) * 2);
    this.audioLength = 0;
    this.phases = new Float64Array(NOTES.length);
    this.sram = new Uint8Array(4);
    this.sramView = new DataView(this.sram.buffer);
    this.buttons = 0;
    this.previousButtons = 0;
    this.reset();
  }

  reset() {
    this.frameCount = 0;
    this.sampleDebt = 0;
    this.phases.fill(0);
    this.audioLength = 0;
    this.draw();
  }

  setInput(buttons) {
    this.buttons = buttons;
  }

  runFrame() {
    this.frameCount++;
    if (this.buttons & ~this.previousButtons & Button.START) {
      this.sramView.setUint32(0, this.sramView.getUint32(0, true) + 1, true);
    }
    this.previousButtons = this.buttons;
    this.draw();
    this.synth();
  }

  getFrameBuffer() {
    return this.frame;
  }

  getAudioSamples() {
    return this.audio.subarray(0, this.audioLength);
  }

  getSaveData() {
    return this.sram;
  }

  loadSaveData(data) {
    this.sram.fill(0);
    this.sram.set(data.subarray(0, this.sram.length));
    this.draw();
  }

  saveState() {
    const state = new Float64Array(STATE_SIZE);
    state[0] = this.frameCount;
    state[1] = this.sampleDebt;
    state.set(this.phases, 2);
    state[2 + NOTES.length] = this.sramView.getUint32(0, true);
    state[3 + NOTES.length] = this.previousButtons;
    return new Uint8Array(state.buffer);
  }

  loadState(bytes) {
    if (bytes.byteLength !== STATE_SIZE * 8) throw new Error('Invalid test core state.');
    const state = new Float64Array(bytes.slice().buffer);
    this.frameCount = state[0];
    this.sampleDebt = state[1];
    this.phases.set(state.subarray(2, 2 + NOTES.length));
    this.sramView.setUint32(0, state[2 + NOTES.length], true);
    this.previousButtons = state[3 + NOTES.length];
    this.draw();
  }

  draw() {
    const { width: w, height: h, pixels } = this;
    pixels.fill(BACKGROUND);

    const barHeight = h >> 2;
    this.fill(0, 0, w, barHeight, (x) => BARS[((x * BARS.length) / w) | 0]);

    // Dither patterns: the De-dither option should turn both into flat colors.
    const top = barHeight + 6;
    this.fill(6, top, 40, 32, (x, y) => ((x + y) & 1 ? DITHER_DARK : DITHER_LIGHT));
    this.fill(52, top, 40, 32, (x) => (x & 1 ? STRIPE_A : STRIPE_B));

    // Disk: staircase edges show what the smoothing filters do.
    const cx = w - 34, cy = top + 16, r = 15;
    this.fill(cx - r, cy - r, r * 2 + 1, r * 2 + 1, (x, y) =>
      (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? DISK : null);

    // Mover: bounces at one pixel per emulated frame, so it speeds up with fast-forward.
    const travel = w - 8;
    const t = this.frameCount % (travel * 2);
    this.fill(t < travel ? t : travel * 2 - t, top + 40, 8, 8, () => MOVER);

    // Saved-game counter, least significant bit on the right.
    const counter = this.sramView.getUint32(0, true);
    for (let bit = 0; bit < 8; bit++) {
      const color = counter & (1 << bit) ? COUNTER_ON : BUTTON_OFF;
      this.fill(w - 14 - bit * 8, h - 26, 6, 6, () => color);
    }

    const slot = (w - 12) / BUTTON_NAMES.length;
    for (let i = 0; i < BUTTON_NAMES.length; i++) {
      const color = this.buttons & (1 << i) ? BUTTON_ON : BUTTON_OFF;
      this.fill(6 + Math.round(i * slot), h - 14, Math.floor(slot) - 3, 8, () => color);
    }
  }

  fill(x0, y0, width, height, color) {
    const { width: w, height: h, pixels } = this;
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + height); y++) {
      for (let x = Math.max(0, x0); x < Math.min(w, x0 + width); x++) {
        const c = color(x, y);
        if (c !== null) pixels[y * w + x] = c;
      }
    }
  }

  synth() {
    const exact = this.sampleRate / this.fps + this.sampleDebt;
    const count = Math.floor(exact);
    this.sampleDebt = exact - count;
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (let b = 0; b < NOTES.length; b++) {
        if (!(this.buttons & (1 << b))) continue;
        this.phases[b] = (this.phases[b] + NOTES[b] / this.sampleRate) % 1;
        value += this.phases[b] < 0.5 ? VOLUME : -VOLUME;
      }
      this.audio[i * 2] = value;
      this.audio[i * 2 + 1] = value;
    }
    this.audioLength = count * 2;
  }
}
