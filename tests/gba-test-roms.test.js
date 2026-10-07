// GBA test ROMs (jsmolka/gba-tests, fetched by `npm run fetch-test-roms`):
// each leaves the number of the first failed test in r12 (0: all passed).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Gba } from '../src/core/gba/gba.js';

const ROOT = new URL('./roms/gba-tests/', import.meta.url).pathname;
const skip = !existsSync(ROOT) && 'test ROMs not fetched (npm run fetch-test-roms)';

const ROMS = [
  'arm/arm.gba', 'thumb/thumb.gba', 'memory/memory.gba', 'bios/bios.gba', 'nes/nes.gba', 'unsafe/unsafe.gba',
  'save/none.gba', 'save/sram.gba', 'save/flash64.gba', 'save/flash128.gba',
];

for (const path of ROMS) {
  test(`gba-tests ${path}`, { skip }, () => {
    const gba = new Gba(new Uint8Array(readFileSync(join(ROOT, path))));
    for (let i = 0; i < 60; i++) gba.runFrame();
    assert.equal(gba.cpu.r[12], 0, `failed test ${gba.cpu.r[12]}`);
  });
}

test('gba-tests save/sram.gba writes a save that survives a reload', { skip }, () => {
  const rom = new Uint8Array(readFileSync(join(ROOT, 'save/sram.gba')));
  const gba = new Gba(rom);
  for (let i = 0; i < 60; i++) gba.runFrame();
  const save = gba.getSaveData();
  assert.ok(save && save.some((b) => b !== 0xff));
  const again = new Gba(rom);
  again.loadSaveData(save);
  assert.deepEqual(again.getSaveData(), save);
});

test('idle-loop skipping leaves gba-tests runs exactly as they were', { skip }, () => {
  for (const path of ['nes/nes.gba', 'ppu/shades.gba', 'save/flash128.gba']) {
    const rom = new Uint8Array(readFileSync(join(ROOT, path)));
    const [on, off] = [true, false].map((enabled) => {
      const gba = new Gba(rom);
      gba.idleLoops.enabled = enabled;
      for (let i = 0; i < 120; i++) gba.runFrame();
      return gba;
    });
    assert.ok(on.idleLoops.skipped > 0, `${path}: something skipped`);
    assert.deepEqual(on.saveState(), off.saveState(), path);
  }
});
