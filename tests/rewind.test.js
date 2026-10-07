import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RewindBuffer } from '../src/app/rewind.js';

/** States that change a few bytes at a time, like a running game. */
function states(count, size = 50_000) {
    const result = [];
    const state = new Uint8Array(size);
    for (let i = 0; i < size; i++) state[i] = (i * 7) & 0xff;
    for (let n = 0; n < count; n++) {
        for (let k = 0; k < 40; k++) state[(n * 997 + k * 131) % size] ^= n + k + 1;
        // A changed run, a gap of 2 and the very last byte.
        state.fill(n, 1000, 1100);
        state[1102] = n;
        state[size - 1] = n;
        result.push(state.slice());
    }
    return result;
}

test('rewind: pops states newest first, exactly as pushed', () => {
    const buffer = new RewindBuffer({ groupSize: 4 });
    const pushed = states(11);
    for (const state of pushed) buffer.push(state);
    assert.equal(buffer.length, 11);
    for (let i = pushed.length - 1; i >= 0; i--) assert.deepEqual(buffer.pop(), pushed[i], `state ${i}`);
    assert.equal(buffer.pop(), null);
    assert.equal(buffer.bytes, 0);
});

test('rewind: deltas are small, and the oldest states go when full', () => {
    const pushed = states(30);
    const buffer = new RewindBuffer({ groupSize: 10, maxBytes: 140_000 });
    for (const state of pushed.slice(0, 10)) buffer.push(state);
    assert.ok(buffer.bytes < 50_000 + 9 * 2000, `${buffer.bytes} bytes for one group`);
    for (const state of pushed.slice(10)) buffer.push(state);
    assert.ok(buffer.bytes <= 140_000);
    assert.equal(buffer.length, 20, 'the oldest group was dropped');
    assert.deepEqual(buffer.pop(), pushed[29]);
    buffer.clear();
    assert.equal(buffer.length, 0);
    assert.equal(buffer.pop(), null);
});

test('rewind: a state of another size starts a new group', () => {
    const buffer = new RewindBuffer();
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    buffer.push(a);
    buffer.push(b);
    assert.deepEqual(buffer.pop(), b);
    assert.deepEqual(buffer.pop(), a);
});
