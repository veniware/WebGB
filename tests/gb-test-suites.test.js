// More Game Boy test ROM suites from the c-sp collection: SameSuite, the AGE
// tests, GBMicrotest, rtc3test, Mooneye (wilbertpol's variant) and
// screenshot-based tests. Known failures are listed in known-failures.js.

import assert from 'node:assert/strict';
import { Button } from '../src/core/buttons.js';
import { GameBoy } from '../src/core/gb/gameboy.js';
import {
  exists, FIBONACCI, listRoms, load, makeGameBoy, registers, romTest, runToOpcode, screenDiff,
} from './test-roms.js';

const runFrames = (gb, frames, input = () => 0) => {
  for (let i = 0; i < frames; i++) {
    gb.setInput(input(i));
    gb.runFrame();
  }
};

// SameSuite (CGB E): LD B,B when done, Fibonacci registers on success.
for (const path of listRoms('same-suite')) {
  if (path.startsWith('same-suite/sgb/') || (/-cgb/.test(path) && !/cgb[0-9A-Z]*E/.test(path))) continue;
  romTest(path, () => {
    const gb = makeGameBoy(path, { cgb: true });
    assert.ok(runToOpcode(gb), 'timed out');
    assert.equal(registers(gb), FIBONACCI);
  });
}

// AGE: named after the models they pass on (dmgC, cgbBCE, ncm = CGB running a
// DMG game, which isn't emulated). Fibonacci registers, or a screenshot.
for (const path of listRoms('age-test-roms', /\.gb$/)) {
  const rom = load(path);
  const base = path.slice(0, -3);
  const dir = base.slice(0, base.lastIndexOf('/'));
  const references = listRoms(dir, /\.png$/).filter((png) => png.startsWith(`${base}-`) &&
    !/^(ds|nocgb)-|ncm/.test(png.slice(base.length + 1)));
  if (references.length) {
    for (const reference of references) {
      const cgb = !/dmg/.test(reference);
      if (cgb && !(rom[0x143] & 0x80)) continue;
      romTest(`${path} (${reference.slice(dir.length + 1)})`, () => {
        const gb = makeGameBoy(path, { cgb });
        assert.ok(runToOpcode(gb), 'timed out');
        runFrames(gb, 2);
        assert.equal(screenDiff(gb, reference), 0);
      });
    }
    continue;
  }
  const tags = base.split('/').pop().split('-');
  const models = [];
  if (tags.some((tag) => tag.startsWith('dmg')) && rom[0x143] !== 0xc0) models.push('dmg');
  if (tags.some((tag) => /^cgb.*[CE]/.test(tag)) && rom[0x143] & 0x80) models.push('cgb');
  for (const model of models) {
    romTest(`${path} (${model})`, () => {
      const gb = makeGameBoy(path, { cgb: model === 'cgb' });
      assert.ok(runToOpcode(gb), 'timed out');
      assert.equal(registers(gb), FIBONACCI);
    });
  }
}

// GBMicrotest (DMG): $FF82 reads 1 on success, $FF on failure (other values:
// not a pass/fail test).
for (const path of listRoms('gbmicrotest', /\.gb$/)) {
  romTest(path, (t) => {
    const gb = makeGameBoy(path);
    runFrames(gb, path.endsWith('is_if_set_during_ime0.gb') ? 30 : 3);
    const result = gb.read(0xff82);
    if (result !== 1 && result !== 0xff) return t.skip('not a pass/fail test');
    assert.equal(result, 1, `got ${gb.read(0xff80)}, expected ${gb.read(0xff81)}`);
  });
}

// rtc3test: the MBC3 clock, run on emulated time. Pick a subtest with the
// buttons, wait, compare the screen.
const RTC3_SUBTESTS = [['basic-tests', [Button.A], 13], ['range-tests', [Button.DOWN, Button.A], 8],
  ['sub-second-writes', [Button.DOWN, Button.DOWN, Button.A], 26]];
for (const [name, buttons, seconds] of RTC3_SUBTESTS) {
  for (const model of ['dmg', 'cgb']) {
    romTest(`rtc3test/rtc3test.gb ${name} (${model})`, () => {
      let cycles = 0;
      const gb = makeGameBoy('rtc3test/rtc3test.gb', { cgb: model === 'cgb', now: () => cycles / 4194.304 });
      const tick = gb.tick.bind(gb);
      gb.tick = () => {
        cycles += gb.doubleSpeed ? 2 : 4;
        tick();
      };
      runFrames(gb, 30);
      for (const button of buttons) {
        runFrames(gb, 5, () => button);
        runFrames(gb, 10);
      }
      runFrames(gb, seconds * 60 + 60);
      assert.equal(screenDiff(gb, `rtc3test/rtc3test-${name}-${model}.png`), 0);
    });
  }
}

// Screenshot tests: [ROM, [reference, model]..., frames to run (0: until LD B,B)].
const SCREENSHOT_TESTS = [
  ['bully/bully.gb', [['bully/bully.png', 'dmg'], ['bully/bully.png', 'cgb']], 30],
  ['strikethrough/strikethrough.gb', [['strikethrough/strikethrough-dmg.png', 'dmg'],
    ['strikethrough/strikethrough-cgb.png', 'cgb']], 30],
  ['turtle-tests/window_y_trigger/window_y_trigger.gb', [['turtle-tests/window_y_trigger/window_y_trigger.png', 'dmg']], 30],
  ['turtle-tests/window_y_trigger_wx_offscreen/window_y_trigger_wx_offscreen.gb',
    [['turtle-tests/window_y_trigger_wx_offscreen/window_y_trigger_wx_offscreen.png', 'dmg']], 30],
  ['scribbltests/lycscy/lycscy.gb', [['scribbltests/lycscy/lycscy-cgb-dmg.png', 'dmg']], 10],
  ['scribbltests/lycscx/lycscx.gb', [['scribbltests/lycscx/lycscx-cgb-dmg.png', 'dmg']], 10],
  ['scribbltests/statcount/statcount-auto.gb', [['scribbltests/statcount/statcount_auto-cgb-dmg.png', 'dmg']], 280],
  ['scribbltests/palettely/palettely.gb', [['scribbltests/palettely/palettely-dmg.png', 'dmg'],
    ['scribbltests/palettely/palettely-cgb.png', 'cgb']], 10],
  ['scribbltests/scxly/scxly.gb', [['scribbltests/scxly/scxly-dmg.png', 'dmg'], ['scribbltests/scxly/scxly-cgb.png', 'cgb']], 10],
  ['little-things-gb/firstwhite.gb', [['little-things-gb/firstwhite-dmg-cgb.png', 'dmg'],
    ['little-things-gb/firstwhite-dmg-cgb.png', 'cgb']], 30],
  ['mbc3-tester/mbc3-tester.gb', [['mbc3-tester/mbc3-tester-dmg.png', 'dmg'], ['mbc3-tester/mbc3-tester-cgb.png', 'cgb']], 80],
  ['cgb-acid-hell/cgb-acid-hell.gbc', [['cgb-acid-hell/cgb-acid-hell.png', 'cgb']], 0],
];
for (const [path, references, frames] of SCREENSHOT_TESTS) {
  for (const [reference, model] of references) {
    if (exists(path) && model === 'cgb' && !(load(path)[0x143] & 0x80)) continue;
    romTest(`${path} (${model})`, () => {
      const gb = makeGameBoy(path, { cgb: model === 'cgb' });
      if (frames) runFrames(gb, frames);
      else {
        assert.ok(runToOpcode(gb), 'timed out');
        runFrames(gb, 2);
      }
      assert.equal(screenDiff(gb, reference), 0);
    });
  }
}

// Telling LYs: press every button, then wait for the verdict.
for (const model of ['dmg', 'cgb']) {
  romTest(`little-things-gb/tellinglys.gb (${model})`, () => {
    const gb = makeGameBoy('little-things-gb/tellinglys.gb', { cgb: model === 'cgb' });
    runFrames(gb, 60);
    for (const button of [Button.A, Button.B, Button.SELECT, Button.START, Button.RIGHT, Button.LEFT, Button.UP, Button.DOWN]) {
      runFrames(gb, 10, () => button);
      runFrames(gb, 10);
    }
    runFrames(gb, 300);
    assert.equal(screenDiff(gb, `little-things-gb/tellinglys-${model}.png`), 0);
  });
}

// Mooneye, wilbertpol's 2016 variant: an illegal opcode (0xED) when done,
// Fibonacci registers on success.
for (const path of listRoms('mooneye-test-suite-wilbertpol', /\.gb$/)) {
  // logic-analysis/: captures for a logic analyzer, not pass/fail tests.
  if (/\/(utils|manual-only|madness|logic-analysis)\//.test(path)) continue;
  const tag = path.match(/-([A-Za-z0-9]+)\.gb$/)?.[1] ?? '';
  const cgb = /^(C|cgb|cgbABCDE|cgbE)$/.test(tag);
  if (tag && !cgb && !/^(dmgABC|dmgABCmgb|dmgABCmgbS|dmgABCX|GS|dmgABCXmgb|dmgABCmgbsgb)$/.test(tag)) continue;
  if (cgb && exists(path) && !(load(path)[0x143] & 0x80)) continue;
  romTest(path, () => {
    const gb = new GameBoy(load(path), { cgb });
    assert.ok(runToOpcode(gb, 0xed, 30_000_000), 'timed out');
    assert.equal(registers(gb), FIBONACCI);
  });
}
