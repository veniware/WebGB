/**
 * Stereo ring buffer with a linear resampler and dynamic rate control.
 *
 * Emulated audio arrives in chunks at the core's rate; the sound card pulls
 * at its own rate. The two clocks never match exactly, so the playback rate
 * is nudged by up to ±maxRateDelta to keep the buffer near its target fill:
 * no audible pitch change, no crackles from under- or overruns.
 */
export class Resampler {
  /**
   * @param {number} outputRate  Sound card sample rate.
   * @param {{ targetLatency?: number, maxRateDelta?: number }} [options]
   */
  constructor(outputRate, { targetLatency = 0.06, maxRateDelta = 0.005 } = {}) {
    this.outputRate = outputRate;
    this.targetLatency = targetLatency;
    this.maxRateDelta = maxRateDelta;
    this.underruns = 0;
    this.inputRate = 0;
    this.setInputRate(48000);
  }

  setInputRate(rate) {
    if (rate === this.inputRate) return;
    this.inputRate = rate;
    this.target = Math.max(1, Math.round(rate * this.targetLatency));
    this.capacity = this.target * 4 + 4096;
    this.buffer = new Float32Array(this.capacity * 2);
    this.clear();
  }

  clear() {
    this.readPos = 0;
    this.count = 0;
    this.frac = 0;
    this.playing = false;
    this.lastLeft = 0;
    this.lastRight = 0;
  }

  /** Buffered input frames. */
  get fill() {
    return this.count;
  }

  /** @param {Float32Array} samples Interleaved stereo. */
  write(samples) {
    let frames = samples.length >> 1;
    if (frames > this.capacity) {
      samples = samples.subarray((frames - this.capacity) * 2);
      frames = this.capacity;
    }
    const free = this.capacity - this.count;
    if (frames > free) this.drop(frames - free);

    const { buffer, capacity } = this;
    let w = (this.readPos + this.count) % capacity;
    for (let i = 0; i < frames; i++) {
      buffer[w * 2] = samples[i * 2];
      buffer[w * 2 + 1] = samples[i * 2 + 1];
      if (++w === capacity) w = 0;
    }
    this.count += frames;

    // Fast-forward produces audio faster than real time: skip ahead rather
    // than let latency build up.
    if (this.count > this.target * 2) this.drop(this.count - this.target);
  }

  drop(frames) {
    frames = Math.min(frames, this.count);
    this.readPos = (this.readPos + frames) % this.capacity;
    this.count -= frames;
  }

  /**
   * Fills one block of output.
   * @param {Float32Array} left
   * @param {Float32Array} right
   */
  process(left, right) {
    if (!this.playing && this.count >= this.target) this.playing = true;

    const error = Math.max(-1, Math.min(1, (this.count - this.target) / this.target));
    const step = (this.inputRate / this.outputRate) * (1 + error * this.maxRateDelta);
    const { buffer, capacity } = this;

    for (let i = 0; i < left.length; i++) {
      if (!this.playing || this.count < 2) {
        if (this.playing) {
          this.playing = false;
          this.underruns++;
        }
        // Fade the last sample out to avoid a click, then wait for a refill.
        this.lastLeft *= 0.995;
        this.lastRight *= 0.995;
        left[i] = this.lastLeft;
        right[i] = this.lastRight;
        continue;
      }
      const a = this.readPos * 2;
      const b = ((this.readPos + 1) % capacity) * 2;
      const f = this.frac;
      left[i] = this.lastLeft = buffer[a] + (buffer[b] - buffer[a]) * f;
      right[i] = this.lastRight = buffer[a + 1] + (buffer[b + 1] - buffer[a + 1]) * f;

      this.frac += step;
      while (this.frac >= 1 && this.count > 0) {
        this.frac -= 1;
        if (++this.readPos === capacity) this.readPos = 0;
        this.count--;
      }
    }
  }
}
