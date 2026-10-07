import assert from "node:assert/strict";
import { test } from "node:test";
import { Resampler } from "../src/audio/resampler.js";

/**
 * Simulates a producer pushing one video frame of audio at a time while the
 * sound card pulls 128-sample blocks. `drift` makes the producer's clock run
 * fast (>1) or slow (<1) relative to the sound card.
 */
function simulate({ seconds, inputRate = 48000, outputRate = 44100, drift = 1, speed = 1, onBlock }) {
    const resampler = new Resampler(outputRate);
    const framesPerChunk = Math.round(inputRate / 60);
    const chunk = new Float32Array(framesPerChunk * 2).fill(0.5);
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    const chunkInterval = framesPerChunk / (inputRate * drift * speed);
    const blockInterval = 128 / outputRate;
    let nextChunk = 0;
    let nextBlock = 0;
    while (Math.min(nextChunk, nextBlock) < seconds) {
        if (nextChunk <= nextBlock) {
            resampler.setInputRate(inputRate);
            resampler.write(chunk);
            nextChunk += chunkInterval;
        } else {
            resampler.process(left, right);
            onBlock?.(resampler, nextBlock);
            nextBlock += blockInterval;
        }
    }
    return resampler;
}

for (const drift of [0.998, 1, 1.002]) {
    test(`keeps the buffer near its target without underruns (clock drift ${drift})`, () => {
        let maxError = 0;
        const resampler = simulate({
            seconds: 60,
            drift,
            onBlock: (r, time) => {
                if (time > 30) maxError = Math.max(maxError, Math.abs(r.fill - r.target) / r.target);
            },
        });
        assert.equal(resampler.underruns, 0);
        assert.ok(maxError < 0.6, `fill strayed ${(maxError * 100).toFixed(0)}% from target`);
    });
}

test("fast-forward skips audio instead of building latency", () => {
    let maxFill = 0;
    simulate({ seconds: 10, speed: 4, onBlock: (r) => (maxFill = Math.max(maxFill, r.fill)) });
    const target = Math.round(48000 * 0.06);
    assert.ok(maxFill <= target * 2 + 1, `fill reached ${maxFill}`);
});

test("fades out instead of clicking on underrun", () => {
    const resampler = new Resampler(48000);
    resampler.write(new Float32Array(resampler.target * 2).fill(1));
    const left = new Float32Array(resampler.target + 500);
    const right = new Float32Array(left.length);
    resampler.process(left, right);
    assert.equal(resampler.underruns, 1);
    const tail = left.subarray(resampler.target);
    for (let i = 1; i < tail.length; i++) assert.ok(tail[i] <= tail[i - 1] && tail[i] >= 0);
    assert.ok(tail.at(-1) < 0.2);
});
