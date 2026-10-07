import assert from "node:assert/strict";
import { test } from "node:test";

import { MemorySearch, parseByte } from "../src/ui/memory-search.js";

function region(bytes) {
    const data = Uint8Array.from(bytes);
    return { name: "RAM", base: 0, size: data.length, data, read: (i) => (i === 2 ? -1 : data[i]), write: (i, v) => (data[i] = v) };
}

test("memory search: find a value, then narrow down by how it changed", () => {
    const ram = region([3, 7, 3, 3, 9, 3]);
    const search = new MemorySearch(ram);
    search.start("equal", 3);
    assert.deepEqual(search.results().map((r) => r.offset), [0, 3, 5], "unreadable bytes are skipped");
    ram.data[0] = 2;
    ram.data[3] = 2;
    search.narrow("decreased");
    assert.deepEqual(search.results(), [{ offset: 0, value: 2 }, { offset: 3, value: 2 }]);
    ram.data[3] = 1;
    search.narrow("changed");
    assert.deepEqual(search.results(), [{ offset: 3, value: 1 }]);
    search.narrow("equal", 1);
    assert.equal(search.count, 1);
});

test("memory search: an unknown value starts with every byte", () => {
    const ram = region([1, 2, 3, 4]);
    const search = new MemorySearch(ram);
    search.start("unchanged");
    assert.equal(search.count, 3);
    ram.data[1] = 5;
    search.narrow("increased");
    assert.deepEqual(search.results(), [{ offset: 1, value: 5 }]);
});

test("memory search: values in decimal or hex", () => {
    assert.equal(parseByte("12"), 12);
    assert.equal(parseByte(" 0x1F "), 0x1f);
    assert.equal(parseByte("$ff"), 255);
    assert.ok(Number.isNaN(parseByte("256")));
    assert.ok(Number.isNaN(parseByte("abc")));
});
