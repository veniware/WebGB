import { Emitter } from '../app/emitter.js';

const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'];
// Echo presets: delay (s), feedback and level of the echoes.
const ECHOES = {
  room: { delay: 0.08, feedback: 0.3, wet: 0.3 },
  hall: { delay: 0.25, feedback: 0.45, wet: 0.35 },
};

/**
 * Plays core audio through an AudioWorklet. Samples pushed during a frame
 * are batched and posted to the audio thread once per flush(). Optional
 * effects (see setEffects) are Web Audio nodes between it and the volume.
 *
 * Events: 'state' (AudioContext state string).
 */
export class AudioOutput extends Emitter {
  #context = null;
  #node = null;
  #gain = null;
  #ready = null;
  #staging = new Float32Array(16384);
  #length = 0;
  #rate = 48000;
  #volume = 1;
  #effects = { pitch: 0, highpass: 0, lowpass: 0, echo: 'off' };
  // Effect nodes currently connected.
  #chain = [];

  /** True while the browser blocks playback until the next user gesture. */
  get blocked() {
    return this.#context?.state === 'suspended';
  }

  /**
   * Creates the AudioContext. Call from a user gesture where possible;
   * otherwise playback starts on the next tap, click or key press.
   * @returns {Promise<boolean>} Whether audio is available.
   */
  init() {
    if (this.#ready) return this.#ready;
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Context || !globalThis.AudioWorkletNode) return (this.#ready = Promise.resolve(false));

    const context = (this.#context = new Context({ latencyHint: 'interactive' }));
    context.addEventListener('statechange', () => this.emit('state', context.state));
    this.#unlockOnGesture();

    this.#ready = context.audioWorklet
      .addModule(new URL('./audio-processor.js', import.meta.url))
      .then(() => {
        this.#node = new AudioWorkletNode(context, 'emulator-audio', {
          numberOfInputs: 0,
          outputChannelCount: [2],
        });
        this.#gain = context.createGain();
        this.#gain.gain.value = this.#volume;
        this.#gain.connect(context.destination);
        this.#connect();
        return true;
      })
      .catch((err) => {
        console.error('Audio unavailable:', err);
        return false;
      });
    return this.#ready;
  }

  #unlockOnGesture() {
    const unlock = () => {
      if (this.#context.state === 'running') {
        for (const type of UNLOCK_EVENTS) window.removeEventListener(type, unlock, true);
      } else {
        this.#context.resume().catch(() => {});
      }
    };
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, unlock, true);
    this.#context.addEventListener('statechange', unlock);
  }

  /** @param {number} volume 0..1 */
  setVolume(volume) {
    this.#volume = volume;
    if (this.#gain) this.#gain.gain.value = volume;
  }

  /**
   * @param {{ pitch?: number, highpass?: number, lowpass?: number, echo?: 'off' | 'room' | 'hall' }} effects
   *   pitch in semitones; filter cutoffs in Hz (0: off).
   */
  setEffects(effects) {
    Object.assign(this.#effects, effects);
    this.#connect();
  }

  /** (Re)builds the chain: player -> pitch -> high pass -> low pass -> echo -> volume. */
  #connect() {
    const context = this.#context;
    if (!this.#node) return;
    this.#node.disconnect();
    for (const node of this.#chain) node.disconnect();
    this.#chain = [];
    const { pitch, highpass, lowpass, echo } = this.#effects;
    let last = this.#node;
    const add = (node) => {
      last.connect(node);
      this.#chain.push(node);
      last = node;
    };
    if (pitch) {
      const shifter = new AudioWorkletNode(context, 'pitch-shift', { outputChannelCount: [2] });
      shifter.parameters.get('ratio').value = 2 ** (pitch / 12);
      add(shifter);
    }
    for (const [type, frequency] of [['highpass', highpass], ['lowpass', lowpass]]) {
      if (!frequency) continue;
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      add(filter);
    }
    const preset = ECHOES[echo];
    if (preset) {
      const input = context.createGain();
      add(input);
      const delay = context.createDelay(1);
      delay.delayTime.value = preset.delay;
      const feedback = context.createGain();
      feedback.gain.value = preset.feedback;
      const wet = context.createGain();
      wet.gain.value = preset.wet;
      const mix = context.createGain();
      input.connect(mix);
      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(mix);
      this.#chain.push(delay, feedback, wet, mix);
      last = mix;
    }
    last.connect(this.#gain);
  }

  /** Queues interleaved stereo samples produced at `rate`. */
  push(samples, rate) {
    if (!this.#node || this.#context.state !== 'running') return;
    if (rate !== this.#rate) {
      this.flush();
      this.#rate = rate;
    }
    const needed = this.#length + samples.length;
    if (needed > this.#staging.length) {
      const grown = new Float32Array(Math.max(needed, this.#staging.length * 2));
      grown.set(this.#staging.subarray(0, this.#length));
      this.#staging = grown;
    }
    this.#staging.set(samples, this.#length);
    this.#length = needed;
  }

  /** Sends queued samples to the audio thread. */
  flush() {
    if (!this.#length) return;
    const samples = this.#staging.slice(0, this.#length);
    this.#length = 0;
    this.#node?.port.postMessage({ type: 'samples', samples, rate: this.#rate }, [samples.buffer]);
  }

  /** Drops everything buffered (after reset, ROM change or snapshot load). */
  clear() {
    this.#length = 0;
    this.#node?.port.postMessage({ type: 'clear' });
  }
}
