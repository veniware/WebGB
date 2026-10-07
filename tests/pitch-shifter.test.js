import assert from "node:assert/strict";
import { test } from "node:test";

import { PitchShifter } from "../src/audio/pitch-shifter.js";

const RATE = 48000;

/** Runs a sine of `frequency` through the shifter; returns the frequency and RMS of the output. */
function shift(frequency, semitones) {
    const shifter = new PitchShifter(RATE);
    const block = 128;
    const length = RATE;
    const output = new Float32Array(length);
    const inLeft = new Float32Array(block);
    const outLeft = new Float32Array(block);
    const outRight = new Float32Array(block);
    for (let start = 0; start < length; start += block) {
        for (let i = 0; i < block; i++) inLeft[i] = Math.sin((2 * Math.PI * frequency * (start + i)) / RATE);
        shifter.process(inLeft, inLeft, outLeft, outRight, 2 ** (semitones / 12));
        output.set(outLeft, start);
    }
    // Skip the start (the delay line filling up), then count rising zero crossings.
    const from = RATE / 4;
    let crossings = 0;
    let sum = 0;
    for (let i = from + 1; i < length; i++) {
        if (output[i - 1] < 0 && output[i] >= 0) crossings++;
        sum += output[i] * output[i];
    }
    const seconds = (length - from) / RATE;
    return { frequency: crossings / seconds, rms: Math.sqrt(sum / (length - from)) };
}

test("pitch shifter: no shift passes the sound through", () => {
    const { frequency, rms } = shift(500, 0);
    assert.ok(Math.abs(frequency - 500) < 3, `${frequency} Hz`);
    assert.ok(Math.abs(rms - Math.SQRT1_2) < 0.05, `rms ${rms}`);
});

test("pitch shifter: an octave up and down, a fifth up", () => {
    for (const [input, semitones] of [[440, 12], [440, -12], [300, 7]]) {
        const expected = input * 2 ** (semitones / 12);
        const { frequency, rms } = shift(input, semitones);
        // Crossfades between the read heads blur the zero crossings a little.
        assert.ok(Math.abs(frequency - expected) / expected < 0.03, `${semitones} st: ${frequency} Hz, expected ${expected}`);
        assert.ok(rms > 0.5, `rms ${rms}`);
    }
});
