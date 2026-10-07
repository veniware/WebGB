// The service worker caches the whole app for offline use: its file list has
// to name every file the page can load.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url).pathname;

function files(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(ROOT, dir, name);
    return statSync(path).isDirectory() ? files(relative(ROOT, path)) : [relative(ROOT, path)];
  });
}

test('sw.js caches every file of the app', () => {
  const source = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  const listed = [...source.match(/const FILES = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const file of listed) {
    if (file !== './') assert.ok(existsSync(join(ROOT, file)), `${file} is listed but doesn't exist`);
  }
  for (const file of [...files('src'), ...files('icons'), 'index.html', 'manifest.webmanifest']) {
    assert.ok(listed.includes(file), `${file} is missing from sw.js`);
  }
});

test('the manifest and its icons', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) assert.ok(existsSync(join(ROOT, icon.src)), icon.src);
});
