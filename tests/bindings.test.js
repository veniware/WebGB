import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Button } from '../src/core/buttons.js';
import {
  defaultKeyBindings, defaultPadBindings, gamepadMaps, keyboardMaps, keyName, padButtonName, withDefaults,
} from '../src/input/bindings.js';
import { DEFAULT_PAD_MAP, FAST_FORWARD_BUTTON, REWIND_BUTTON } from '../src/input/gamepad.js';
import { DEFAULT_HOTKEYS, DEFAULT_KEY_MAP } from '../src/input/keyboard.js';

test('default bindings give back the default key and gamepad maps', () => {
  const keys = keyboardMaps(defaultKeyBindings());
  assert.deepEqual(keys.keyMap, DEFAULT_KEY_MAP);
  assert.deepEqual(keys.hotkeys, DEFAULT_HOTKEYS);
  const pad = gamepadMaps(defaultPadBindings());
  assert.deepEqual(new Set(pad.map.map(String)), new Set(DEFAULT_PAD_MAP.map(String)));
  assert.deepEqual(pad.fastForward, [FAST_FORWARD_BUTTON]);
  assert.deepEqual(pad.rewind, [REWIND_BUTTON]);
});

test('saved bindings override the defaults, action by action', () => {
  const bindings = withDefaults({ A: ['KeyQ'], unknown: ['KeyU'], B: 'not a list' }, defaultKeyBindings());
  const { keyMap } = keyboardMaps(bindings);
  assert.equal(keyMap.KeyQ, Button.A);
  assert.equal(keyMap.KeyX, undefined);
  assert.equal(keyMap.KeyZ, Button.B);
  assert.equal(keyMap.KeyU, undefined);
  // Not shared with the defaults.
  bindings.UP.push('KeyW');
  assert.deepEqual(defaultKeyBindings().UP, ['ArrowUp']);
});

test('readable names for keys and gamepad buttons', () => {
  assert.equal(keyName('KeyX'), 'X');
  assert.equal(keyName('Digit5'), '5');
  assert.equal(keyName('ArrowLeft'), '←');
  assert.equal(keyName('ShiftRight'), 'Right Shift');
  assert.equal(keyName('Numpad4'), 'Num 4');
  assert.equal(padButtonName(0), 'Bottom button');
  assert.equal(padButtonName(20), 'Button 20');
});
