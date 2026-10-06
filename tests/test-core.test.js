import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Button } from '../src/core/buttons.js';
import { TestCore } from '../src/core/test/test-core.js';
import { InputManager } from '../src/input/input-manager.js';

test('test core uses the native resolution of each system', () => {
  assert.deepEqual([new TestCore('gb').width, new TestCore('gb').height], [160, 144]);
  assert.deepEqual([new TestCore('gba').width, new TestCore('gba').height], [240, 160]);
  assert.equal(new TestCore('gba').getFrameBuffer().length, 240 * 160 * 4);
});

test('test core produces audio at its sample rate', () => {
  const core = new TestCore();
  core.setInput(Button.A);
  const videoFrames = 120;
  let frames = 0;
  for (let i = 0; i < videoFrames; i++) {
    core.runFrame();
    frames += core.getAudioSamples().length / 2;
  }
  const expected = (core.sampleRate * videoFrames) / core.fps;
  assert.ok(Math.abs(frames - expected) < 1, `produced ${frames} frames, expected ${expected}`);
  assert.ok(core.getAudioSamples().some((s) => s !== 0));
});

test('test core state round-trips through saveState/loadState', () => {
  const core = new TestCore();
  core.setInput(Button.B | Button.UP);
  for (let i = 0; i < 10; i++) core.runFrame();
  const state = core.saveState();
  for (let i = 0; i < 5; i++) core.runFrame();
  const expectedFrame = core.getFrameBuffer().slice();
  const expectedAudio = core.getAudioSamples().slice();

  core.loadState(state);
  for (let i = 0; i < 5; i++) core.runFrame();
  assert.deepEqual(core.getFrameBuffer(), expectedFrame);
  assert.deepEqual(core.getAudioSamples(), expectedAudio);
  assert.throws(() => core.loadState(new Uint8Array(3)));
});

test('input manager merges sources and cancels opposite directions', () => {
  const source = (buttons, fastForward = false) => ({ poll: () => ({ buttons, fastForward }) });
  const input = new InputManager([source(Button.A | Button.LEFT), source(Button.RIGHT | Button.UP, true)]);
  assert.deepEqual(input.poll(), { buttons: Button.A | Button.UP, fastForward: true });
});

test('test core counts Start presses in battery RAM', () => {
  const core = new TestCore();
  for (let i = 0; i < 3; i++) {
    core.setInput(Button.START);
    core.runFrame();
    core.runFrame();
    core.setInput(0);
    core.runFrame();
  }
  assert.deepEqual([...core.getSaveData()], [3, 0, 0, 0]);

  const other = new TestCore();
  other.loadSaveData(new Uint8Array([7, 0]));
  assert.deepEqual([...other.getSaveData()], [7, 0, 0, 0]);

  const state = core.saveState();
  other.loadState(state);
  assert.deepEqual([...other.getSaveData()], [3, 0, 0, 0]);
});
