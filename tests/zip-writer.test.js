import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractZipEntry, isZip, listZip } from '../src/rom/zip.js';
import { createZip } from '../src/util/zip-writer.js';

test('zip writer: entries read back with the zip reader', async () => {
    const big = new Uint8Array(100_000).map((_, i) => (i * 31) & 0xff);
    const blob = createZip([
        { name: 'webgb-backup.json', data: new TextEncoder().encode('{"a":1}') },
        { name: 'roms/key/Pokémon.gb', data: big, date: Date.UTC(2024, 4, 6, 12, 30) },
        { name: 'empty', data: new Uint8Array(0) },
    ]);
    const data = new Uint8Array(await blob.arrayBuffer());
    assert.ok(isZip(data));
    const entries = listZip(data);
    assert.deepEqual(entries.map((e) => e.name), ['webgb-backup.json', 'roms/key/Pokémon.gb', 'empty']);
    assert.equal(new TextDecoder().decode(await extractZipEntry(data, entries[0])), '{"a":1}');
    assert.deepEqual(await extractZipEntry(data, entries[1]), big);
    assert.equal((await extractZipEntry(data, entries[2])).length, 0);
});
