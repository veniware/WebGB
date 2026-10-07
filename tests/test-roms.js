// Shared helpers for the test ROM suites (gb-test-roms.test.js,
// gb-test-suites.test.js). The ROMs are not in the repository; fetch them with
// `npm run fetch-test-roms` (into tests/roms/), otherwise the tests are skipped.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { GameBoy } from '../src/core/gb/gameboy.js';
import { DMG_PALETTES } from '../src/core/gb/palettes.js';
import { KNOWN_FAILURES } from './known-failures.js';
import { decodePng } from './png.js';

export const ROOT = new URL('./roms/', import.meta.url).pathname;
export const available = existsSync(join(ROOT, 'blargg'));

export function load(path) {
  return new Uint8Array(readFileSync(join(ROOT, path)));
}

export function exists(path) {
  return existsSync(join(ROOT, path));
}

/** ROM files under a directory of tests/roms/, as paths relative to it. */
export function listRoms(dir, extensions = /\.gbc?$/) {
  const path = join(ROOT, dir);
  if (!existsSync(path)) return [];
  return readdirSync(path).sort().flatMap((name) => {
    const full = join(path, name);
    if (statSync(full).isDirectory()) return listRoms(relative(ROOT, full), extensions);
    return extensions.test(name) ? [relative(ROOT, full)] : [];
  });
}

/** A test that is skipped when the ROMs are missing or the test is a known failure. */
export function romTest(name, fn) {
  const reason = KNOWN_FAILURES[name];
  test(name, { skip: !available ? 'test ROMs not fetched (npm run fetch-test-roms)' : reason && `known failure: ${reason}` }, fn);
}

/**
 * A Game Boy showing the colors reference screenshots use: DMG shades
 * #000/#555/#AAA/#FFF, CGB colors without correction.
 */
export function makeGameBoy(path, { cgb = false, now } = {}) {
  const gb = new GameBoy(load(path), { cgb, now });
  gb.configure({ gbPalette: 'gray', colorCorrection: false });
  if (!cgb) gb.ppu.setDmgPalette(DMG_PALETTES.gray);
  return gb;
}

/** Runs until the CPU is about to execute `opcode` (LD B,B: 0x40); false on timeout. */
export function runToOpcode(gb, opcode = 0x40, maxSteps = 20_000_000) {
  const { cpu } = gb;
  for (let i = 0; i < maxSteps; i++) {
    if (!cpu.halted && gb.read(cpu.pc) === opcode) return true;
    cpu.step();
  }
  return false;
}

/** Mooneye-style success: B C D E H L hold 3 5 8 13 21 34. */
export function registers(gb) {
  const { b, c, d, e, h, l } = gb.cpu;
  return [b, c, d, e, h, l].join(' ');
}
export const FIBONACCI = '3 5 8 13 21 34';

/** Number of pixels that differ from a reference screenshot. */
export function screenDiff(gb, reference) {
  const frame = gb.getFrameBuffer();
  const expected = decodePng(load(reference)).pixels;
  let different = 0;
  for (let i = 0; i < frame.length; i += 4) {
    if (frame[i] !== expected[i] || frame[i + 1] !== expected[i + 1] || frame[i + 2] !== expected[i + 2]) different++;
  }
  return different;
}
