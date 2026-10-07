import assert from "node:assert/strict";
import { test } from "node:test";
import { detectRom } from "../src/rom/detect.js";
import { loadRomFile } from "../src/rom/loader.js";
import { extractZipEntry, isZip, listZip } from "../src/rom/zip.js";
import { crc32 } from "../src/util/crc32.js";
import { makeGbaRom, makeGbRom, makeZip } from "./helpers.js";

test("crc32 matches the standard check value", () => {
    assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("detects Game Boy, Game Boy Color and GBA headers", () => {
    assert.deepEqual(detectRom(makeGbRom({ title: "TETRIS" })), { system: "gb", title: "TETRIS", cartType: 0 });
    assert.equal(detectRom(makeGbRom({ cgb: 0x80 })).system, "gbc");
    assert.equal(detectRom(makeGbRom({ cgb: 0xc0 })).system, "gbc");
    assert.deepEqual(detectRom(makeGbaRom({ title: "POKEMON", code: "BPEE" })), {
        system: "gba",
        title: "POKEMON",
        code: "BPEE",
    });
});

test("falls back to the file extension when the header is missing", () => {
    const blank = new Uint8Array(0x8000);
    assert.equal(detectRom(blank, "homebrew.gb").system, "gb");
    assert.equal(detectRom(blank, "homebrew.gbc").system, "gbc");
    assert.equal(detectRom(blank, "homebrew.gba").system, "gba");
    assert.throws(() => detectRom(blank, "notes.txt"), /Not a Game Boy/);
    assert.throws(() => detectRom(new Uint8Array(16), "tiny.gb"), /Not a Game Boy/);
});

test("reads stored and deflated zip entries", async () => {
    const text = new TextEncoder().encode("hello hello hello hello");
    const rom = makeGbRom();
    const zip = makeZip([
        { name: "readme.txt", data: text, method: 0 },
        { name: "dir/game.gb", data: rom, method: 8 },
    ]);
    assert.ok(isZip(zip));
    const entries = listZip(zip);
    assert.deepEqual(entries.map((e) => e.name), ["readme.txt", "dir/game.gb"]);
    assert.deepEqual(await extractZipEntry(zip, entries[0]), text);
    assert.deepEqual(await extractZipEntry(zip, entries[1]), rom);
});

test("loads a ROM from a zip file and derives a stable key", async () => {
    const rom = makeGbaRom();
    const file = new File([makeZip([{ name: "games/test.gba", data: rom }])], "test.zip");
    const loaded = await loadRomFile(file);
    assert.equal(loaded.name, "test.gba");
    assert.equal(loaded.info.system, "gba");
    assert.deepEqual(loaded.data, rom);
    assert.equal(loaded.key, `gba-${crc32(rom).toString(16).padStart(8, "0")}-${rom.length}`);
});

test("rejects zips without a ROM", async () => {
    const file = new File([makeZip([{ name: "readme.txt", data: new Uint8Array(4) }])], "x.zip");
    await assert.rejects(loadRomFile(file), /No \.gb, \.gbc or \.gba file/);
});
