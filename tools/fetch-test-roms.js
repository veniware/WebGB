#!/usr/bin/env node
// Downloads the open-source test ROMs used by tests/gb-test-roms.test.js into
// tests/roms/ (ignored by git). They come from the game-boy-test-roms
// collection by c-sp, which bundles Blargg's tests, the Mooneye Test Suite,
// dmg-acid2 and cgb-acid2 (each under its own license).
//
//   node tools/fetch-test-roms.js              download the release zip
//   node tools/fetch-test-roms.js file.zip     use a zip downloaded before

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractZipEntry, listZip } from '../src/rom/zip.js';

const VERSION = 'v7.0';
const RELEASE = `https://github.com/c-sp/game-boy-test-roms/releases/download/${VERSION}/game-boy-test-roms-${VERSION}.zip`;
const SUITES = /(?:^|\/)((?:blargg|mooneye-test-suite|dmg-acid2|cgb-acid2)\/.+)$/;
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
