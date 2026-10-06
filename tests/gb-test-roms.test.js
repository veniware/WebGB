// Runs open-source Game Boy test ROMs: Blargg's tests, the Mooneye Test
// Suite, dmg-acid2 and cgb-acid2. They are not in the repository; fetch them
// with `npm run fetch-test-roms` (into tests/roms/), otherwise these are skipped.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { GameBoy } from '../src/core/gb/gameboy.js';
import { DMG_PALETTES } from '../src/core/gb/palettes.js';
import { decodePng } from './png.js';

const ROOT = new URL('./roms/', import.meta.url).pathname;
const available = existsSync(join(ROOT, 'blargg'));

// Known failures, with the reason. Keep this list short and honest.
const KNOWN_FAILURES = {
  'blargg/dmg_sound/rom_singles/09-wave read while on.gb': 'DMG wave RAM access timing quirks',
  'blargg/dmg_sound/rom_singles/10-wave trigger while on.gb': 'DMG wave RAM corruption on retrigger',
  'blargg/dmg_sound/rom_singles/12-wave write while on.gb': 'DMG wave RAM access timing quirks',
  'mooneye-test-suite/acceptance/boot_div-dmgABCmgb.gb': 'exact DIV phase after the boot ROM',
  'mooneye-test-suite/acceptance/boot_hwio-dmgABCmgb.gb': 'exact I/O state after the boot ROM',
  'mooneye-test-suite/acceptance/serial/boot_sclk_align-dmgABCmgb.gb': 'serial clock phase after the boot ROM',
  'mooneye-test-suite/acceptance/timer/rapid_toggle.gb': 'sub-M-cycle timing of timer glitches',
  'mooneye-test-suite/misc/bits/unused_hwio-C.gb': 'CGB unused I/O bits',
};

function load(path) {
  return new Uint8Array(readFileSync(join(ROOT, path)));
}

function romTest(path, fn) {
  const reason = KNOWN_FAILURES[path];
  test(path, { skip: !available ? 'test ROMs not fetched (npm run fetch-test-roms)' : reason && `known failure: ${reason}` }, fn);
}

/**
 * Blargg's tests print to the serial port and/or write a status to cartridge
 * RAM ($A000 = 0 on success, signature DE B0 61 at $A001).
 */
function runBlargg(path, { cgb = false, seconds = 60 } = {}) {
  const gb = new GameBoy(load(path), { cgb });
  let serial = '';
  gb.serial.onByte = (byte) => (serial += String.fromCharCode(byte));
  const ram = gb.cart.ram;
  for (let frame = 0; frame < seconds * 60; frame++) {
    gb.runFrame();
    if (/Passed|Failed/.test(serial)) return serial;
    if (ram.length > 4 && ram[1] === 0xde && ram[2] === 0xb0 && ram[3] === 0x61 && ram[0] !== 0x80) {
      let text = '';
      for (let i = 4; ram[i]; i++) text += String.fromCharCode(ram[i]);
      return text;
    }
  }
  return `timed out: ${serial}`;
}

const BLARGG = [
  ['blargg/cpu_instrs/cpu_instrs.gb', {}],
  ['blargg/instr_timing/instr_timing.gb', {}],
  ['blargg/mem_timing/mem_timing.gb', {}],
  ['blargg/mem_timing-2/mem_timing.gb', {}],
  ['blargg/halt_bug.gb', {}],
  ['blargg/interrupt_time/interrupt_time.gb', { cgb: true }],
  ['blargg/cgb_sound/cgb_sound.gb', { cgb: true }],
  ...(available ? readdirSync(join(ROOT, 'blargg/dmg_sound/rom_singles')).sort() : []).map((name) => [
    `blargg/dmg_sound/rom_singles/${name}`,
    {},
  ]),
];

for (const [path, options] of BLARGG) {
  romTest(path, () => assert.match(runBlargg(path, options), /Passed/));
}

/** Mooneye tests send 3 5 8 13 21 34 over serial on success (0x42 x 6 on failure). */
function runMooneye(path, cgb) {
  const gb = new GameBoy(load(path), { cgb });
  const out = [];
  gb.serial.onByte = (byte) => out.push(byte);
  for (let frame = 0; frame < 120 * 60 && out.length < 6; frame++) gb.runFrame();
  return out.join(' ');
}

function listRoms(dir) {
  const path = join(ROOT, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    if (statSync(full).isDirectory()) return listRoms(relative(ROOT, full));
    return name.endsWith('.gb') ? [relative(ROOT, full)] : [];
  });
}

/**
 * Tests are named after the models they pass on; run the ones for the
 * models emulated here: DMG (rev. A-C) and CGB running CGB games.
 */
function mooneyeModel(path) {
  const tag = path.match(/-([A-Za-z0-9]+)\.gb$/)?.[1];
  if (!tag) return 'dmg';
  if (/^(dmgABC|dmgABCmgb|GS)$/.test(tag)) return 'dmg';
  if (/^(C|cgb|cgbABCDE)$/.test(tag)) return 'cgb';
  return null;
}

// The misc/boot_* tests expect the state the CGB boot ROM leaves for DMG
// games, which isn't emulated (DMG games run as DMG).
const mooneye = [...listRoms('mooneye-test-suite/acceptance'), ...listRoms('mooneye-test-suite/emulator-only'),
  ...listRoms('mooneye-test-suite/misc').filter((path) => !path.includes('/boot_'))].sort();
for (const path of mooneye) {
  const model = mooneyeModel(path);
  if (!model) continue;
  romTest(path, () => assert.equal(runMooneye(path, model === 'cgb'), '3 5 8 13 21 34'));
}
if (!available) romTest('mooneye-test-suite', () => {});

/** The acid2 tests execute LD B,B when done; the screen must match the reference. */
function runAcid(path, reference, cgb) {
  const gb = new GameBoy(load(path), { cgb });
  gb.ppu.setDmgPalette(DMG_PALETTES.gray);
  const { cpu } = gb;
  for (let i = 0; i < 10_000_000 && (cpu.halted || gb.read(cpu.pc) !== 0x40); i++) cpu.step();
  for (let i = 0; i < 3; i++) gb.runFrame();
  const frame = gb.getFrameBuffer();
  const expected = decodePng(load(reference)).pixels;
  let different = 0;
  for (let i = 0; i < frame.length; i += 4) {
    if (frame[i] !== expected[i] || frame[i + 1] !== expected[i + 1] || frame[i + 2] !== expected[i + 2]) different++;
  }
  return different;
}

romTest('dmg-acid2/dmg-acid2.gb', () => {
  assert.equal(runAcid('dmg-acid2/dmg-acid2.gb', 'dmg-acid2/dmg-acid2-dmg.png', false), 0);
});
romTest('cgb-acid2/cgb-acid2.gbc', () => {
  assert.equal(runAcid('cgb-acid2/cgb-acid2.gbc', 'cgb-acid2/cgb-acid2.png', true), 0);
});
