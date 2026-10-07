/**
 * Pitch shifter (two-tap delay line): two read heads sweep through a short
 * delay at a speed that resamples the sound by `ratio`, each faded in and out
 * over its sweep; with the heads half a sweep apart the fades add up to a
 * steady level. Changes pitch without changing tempo. Pure DSP, used by the
 * 'pitch-shift' AudioWorklet processor.
 */
export class PitchShifter {
    /** @param {number} sampleRate */
    constructor(sampleRate) {
        // The sweep: long enough for low notes, short enough not to echo.
        this.window = Math.round(sampleRate * 0.06);
        this.size = this.window * 2 + 4;
        this.left = new Float32Array(this.size);
        this.right = new Float32Array(this.size);
        this.write = 0;
        this.phase = 0;
    }

    /**
     * @param {Float32Array} inLeft
     * @param {Float32Array} inRight
     * @param {Float32Array} outLeft
     * @param {Float32Array} outRight
     * @param {number} ratio    Pitch factor (2: an octave up).
     */
    process(inLeft, inRight, outLeft, outRight, ratio) {
        const { left, right, size, window } = this;
        // How far the delay changes per sample: 1 - ratio samples.
        const step = (1 - ratio) / window;
        let { write, phase } = this;
        for (let i = 0; i < inLeft.length; i++) {
            left[write] = inLeft[i];
            right[write] = inRight[i];
            phase -= Math.floor(phase);
            const other = phase + 0.5 - Math.floor(phase + 0.5);
            // Fades: sin² of phases half a turn apart add up to 1.
            const sine = Math.sin(Math.PI * phase);
            const gain = sine * sine;
            read(left, right, write, 1 + phase * window, size);
            const aLeft = tap.l;
            const aRight = tap.r;
            read(left, right, write, 1 + other * window, size);
            outLeft[i] = aLeft * gain + tap.l * (1 - gain);
            outRight[i] = aRight * gain + tap.r * (1 - gain);
            write = write + 1 === size ? 0 : write + 1;
            phase += step;
        }
        this.write = write;
        this.phase = phase - Math.floor(phase);
    }
}

const tap = { l: 0, r: 0 };

/** The sample `delay` samples before `write`, interpolated (into `tap`). */
function read(left, right, write, delay, size) {
    let position = write - delay;
    if (position < 0) position += size;
    const i = Math.floor(position);
    const f = position - i;
    const j = i + 1 === size ? 0 : i + 1;
    tap.l = left[i] + (left[j] - left[i]) * f;
    tap.r = right[i] + (right[j] - right[i]) * f;
}
