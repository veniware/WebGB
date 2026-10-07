// Runs open-source Game Boy test ROMs: Blargg's tests, the Mooneye Test
// Suite, the Mealybug Tearoom tests, dmg-acid2 and cgb-acid2 (more suites in
// gb-test-suites.test.js). Fetch them with `npm run fetch-test-roms`;
// otherwise these are skipped. Known failures: known-failures.js.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { GameBoy } from "../src/core/gb/gameboy.js";
import { available, exists, listRoms, load, makeGameBoy, ROOT, romTest, runToOpcode, screenDiff } from "./test-roms.js";

/**
 * Blargg's tests print to the serial port and/or write a status to cartridge
 * RAM ($A000 = 0 on success, signature DE B0 61 at $A001).
 */
function runBlargg(path, { cgb = false, seconds = 60 } = {}) {
    const gb = new GameBoy(load(path), { cgb });
    let serial = "";
    gb.serial.onByte = (byte) => (serial += String.fromCharCode(byte));
    const ram = gb.cart.ram;
    for (let frame = 0; frame < seconds * 60; frame++) {
        gb.runFrame();
        if (/Passed|Failed/.test(serial)) return serial;
        if (ram.length > 4 && ram[1] === 0xde && ram[2] === 0xb0 && ram[3] === 0x61 && ram[0] !== 0x80) {
            let text = "";
            for (let i = 4; ram[i]; i++) text += String.fromCharCode(ram[i]);
            return text;
        }
    }
    return `timed out: ${serial}`;
}

const BLARGG = [
    ["blargg/cpu_instrs/cpu_instrs.gb", {}],
    ["blargg/instr_timing/instr_timing.gb", {}],
    ["blargg/mem_timing/mem_timing.gb", {}],
    ["blargg/mem_timing-2/mem_timing.gb", {}],
    ["blargg/halt_bug.gb", {}],
    ["blargg/oam_bug/oam_bug.gb", {}],
    ["blargg/dmg_sound/dmg_sound.gb", {}],
    ["blargg/interrupt_time/interrupt_time.gb", { cgb: true }],
    ["blargg/cgb_sound/cgb_sound.gb", { cgb: true }],
    ...(available ? readdirSync(join(ROOT, "blargg/dmg_sound/rom_singles")).sort() : []).map((name) => [
        `blargg/dmg_sound/rom_singles/${name}`,
        {},
    ]),
];

for (const [path, options] of BLARGG) {
    romTest(path, () => assert.match(runBlargg(path, options), /Passed/));
}

/**
 * Mooneye tests send 3 5 8 13 21 34 over serial on success (0x42 x 6 on
 * failure), possibly after bytes of their own transfers.
 */
function runMooneye(path, cgb) {
    const gb = new GameBoy(load(path), { cgb });
    let out = [];
    gb.serial.onByte = (byte) => (out = [...out, byte].slice(-6));
    const done = () => out.length === 6 && (out[0] === 3 || out.every((byte) => byte === 0x42));
    for (let frame = 0; frame < 120 * 60 && !done(); frame++) gb.runFrame();
    return out.join(" ");
}


/**
 * Tests are named after the models they pass on; run the ones for the
 * models emulated here: DMG (rev. A-C) and CGB running CGB games.
 */
function mooneyeModel(path) {
    const tag = path.match(/-([A-Za-z0-9]+)\.gb$/)?.[1];
    if (!tag) return "dmg";
    if (/^(dmgABC|dmgABCmgb|GS)$/.test(tag)) return "dmg";
    if (/^(C|cgb|cgbABCDE)$/.test(tag)) return "cgb";
    return null;
}

// The misc/boot_* and unused_hwio-C tests are DMG games on a CGB (its DMG
// compatibility mode), which isn't emulated: DMG games run as DMG.
const mooneye = [...listRoms("mooneye-test-suite/acceptance", /\.gb$/), ...listRoms("mooneye-test-suite/emulator-only", /\.gb$/),
    ...listRoms("mooneye-test-suite/misc", /\.gb$/).filter((path) => !/\/boot_|unused_hwio-C/.test(path))].sort();
for (const path of mooneye) {
    const model = mooneyeModel(path);
    if (!model) continue;
    romTest(path, () => assert.equal(runMooneye(path, model === "cgb"), "3 5 8 13 21 34"));
}
if (!available) romTest("mooneye-test-suite", () => {});

/** The acid2 tests execute LD B,B when done; the screen must match the reference. */
function runAcid(path, reference, cgb, gbPalette) {
    const gb = makeGameBoy(path, { cgb });
    if (gbPalette) gb.configure({ gbPalette });
    runToOpcode(gb, 0x40, 10_000_000);
    for (let i = 0; i < 3; i++) gb.runFrame();
    return screenDiff(gb, reference);
}

// Mealybug Tearoom: register changes in the middle of a line (DMG screenshots).
const MEALYBUG = "mealybug-tearoom-tests/ppu";
const mealybug = available && exists(MEALYBUG)
    ? readdirSync(join(ROOT, MEALYBUG)).filter((name) => name.endsWith(".gb")).sort() : [];
for (const name of mealybug) {
    const base = name.slice(0, -3);
    const reference = [`${base}_dmg_blob.png`, `${base}_dmg_b.png`].find((file) => exists(`${MEALYBUG}/${file}`));
    if (!reference) continue;
    romTest(`${MEALYBUG}/${name}`, () => {
        assert.equal(runAcid(`${MEALYBUG}/${name}`, `${MEALYBUG}/${reference}`, false), 0);
    });
}

romTest("dmg-acid2/dmg-acid2.gb", () => {
    assert.equal(runAcid("dmg-acid2/dmg-acid2.gb", "dmg-acid2/dmg-acid2-dmg.png", false), 0);
});
romTest("dmg-acid2/dmg-acid2.gb (Game Boy Color palette)", () => {
    assert.equal(runAcid("dmg-acid2/dmg-acid2.gb", "dmg-acid2/dmg-acid2-cgb.png", false, "gbc"), 0);
});
romTest("cgb-acid2/cgb-acid2.gbc", () => {
    assert.equal(runAcid("cgb-acid2/cgb-acid2.gbc", "cgb-acid2/cgb-acid2.png", true), 0);
});
