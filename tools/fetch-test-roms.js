#!/usr/bin/env node
// Downloads the open-source test ROMs used by the tests into tests/roms/
// (ignored by git). The Game Boy ones come from the game-boy-test-roms
// collection by c-sp, which bundles Blargg's tests, the Mooneye Test Suite,
// the acid2 tests, SameSuite and others (each under its own license); the
// GBA ones are Julian Smolka's gba-tests (MIT).
//
//   node tools/fetch-test-roms.js              download the release zip
//   node tools/fetch-test-roms.js file.zip     use a zip downloaded before

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractZipEntry, listZip } from '../src/rom/zip.js';

const VERSION = 'v7.0';
const RELEASE = `https://github.com/c-sp/game-boy-test-roms/releases/download/${VERSION}/game-boy-test-roms-${VERSION}.zip`;
const SUITES = new RegExp(`(?:^|/)((?:${[
  'age-test-roms', 'blargg', 'bully', 'cgb-acid-hell', 'cgb-acid2', 'dmg-acid2', 'gbmicrotest', 'little-things-gb',
  'mbc3-tester', 'mealybug-tearoom-tests', 'mooneye-test-suite', 'mooneye-test-suite-wilbertpol', 'rtc3test',
  'same-suite', 'scribbltests', 'strikethrough', 'turtle-tests',
].join('|')})/.+)$`);
const target = new URL('../tests/roms/', import.meta.url).pathname;

const file = process.argv[2];
let data;
if (file) {
  data = new Uint8Array(await readFile(file));
} else {
  console.log(`Downloading ${RELEASE}`);
  const response = await fetch(RELEASE);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  data = new Uint8Array(await response.arrayBuffer());
}

let count = 0;
for (const entry of listZip(data)) {
  const path = entry.name.match(SUITES)?.[1];
  if (!path || path.endsWith('/') || path.split('/').includes('..')) continue;
  const out = join(target, path);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await extractZipEntry(data, entry));
  count++;
}
console.log(`Extracted ${count} files to tests/roms/.`);

// GBA: jsmolka/gba-tests, at a fixed commit.
const GBA_TESTS = 'https://raw.githubusercontent.com/jsmolka/gba-tests/a7113b67e63f83a9b321696ddd7042ccfad6c881/';
const GBA_FILES = [
  'arm/arm.gba', 'bios/bios.gba', 'memory/memory.gba', 'nes/nes.gba', 'ppu/hello.gba', 'ppu/shades.gba',
  'ppu/stripes.gba', 'save/flash128.gba', 'save/flash64.gba', 'save/none.gba', 'save/sram.gba', 'thumb/thumb.gba',
  'unsafe/unsafe.gba',
];
try {
  for (const name of GBA_FILES) {
    const response = await fetch(GBA_TESTS + name);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const out = join(target, 'gba-tests', name);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, new Uint8Array(await response.arrayBuffer()));
  }
  console.log(`Downloaded ${GBA_FILES.length} GBA test ROMs to tests/roms/gba-tests/.`);
} catch (err) {
  console.warn(`GBA test ROMs not downloaded: ${err.message}`);
}
