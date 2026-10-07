// GBA core unit tests: hand-assembled programs and the components on their own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createCore } from "../src/core/registry.js";
import { BackupType, detectBackup } from "../src/core/gba/backup.js";
import { Gba } from "../src/core/gba/gba.js";
import { Gpio } from "../src/core/gba/gpio.js";
import { Timers } from "../src/core/gba/timers.js";
import { Button } from "../src/core/buttons.js";

const IDLE = 0xeafffffe; // b .

/**
 * A cartridge: a jump over the header to `code` (ARM words at 0x080000C0),
 * then an idle loop followed by `after` words.
 */
function cart(code = [], { gameCode = "TEST", after = [], extra = "" } = {}) {
    const rom = new Uint8Array(0x1000);
    const view = new DataView(rom.buffer);
    view.setUint32(0, 0xea00002e, true); // b 0x080000C0
    rom.set(new TextEncoder().encode(gameCode), 0xac);
    [...code, IDLE, ...after].forEach((word, i) => view.setUint32(0xc0 + i * 4, word >>> 0, true));
    rom.set(new TextEncoder().encode(extra), 0x800);
    return rom;
}

function run(gba, frames) {
    for (let i = 0; i < frames; i++) gba.runFrame();
}

/** Dominant frequency of interleaved stereo samples (left channel), by zero crossings. */
function frequency(samples) {
    const left = samples.filter((_, i) => i % 2 === 0);
    const mean = left.reduce((a, v) => a + v, 0) / left.length;
    let crossings = 0;
    for (let i = 1; i < left.length; i++) if ((left[i - 1] < mean) !== (left[i] < mean)) crossings++;
    return crossings / 2 / (left.length / 48000);
}

function collectAudio(gba, frames) {
    const out = [];
    for (let i = 0; i < frames; i++) {
        gba.runFrame();
        out.push(...gba.getAudioSamples());
    }
    return out;
}

test("the registry runs GBA games on the GBA core", async () => {
    const { core, fallback } = await createCore(cart(), { system: "gba" });
    assert.equal(fallback, false);
    assert.equal(core.id, "gba");
    assert.deepEqual([core.width, core.height], [240, 160]);
});

test("BIOS calls leave the BIOS's values in the other registers", () => {
    // Div(100, 7): r0 quotient, r1 remainder, r3 |quotient|.
    let gba = new Gba(cart([0xe3a00064, 0xe3a01007, 0xef060000]));
    run(gba, 2);
    assert.deepEqual([gba.cpu.r[0], gba.cpu.r[1], gba.cpu.r[3]], [14, 2, 14]);
    // Sqrt(0x10000).
    gba = new Gba(cart([0xe3a00801, 0xef080000]));
    run(gba, 2);
    assert.equal(gba.cpu.r[0], 256);
    // ArcTan(0x4000): r1 and r3 hold intermediate values, as on hardware.
    gba = new Gba(cart([0xe3a00901, 0xef090000]));
    run(gba, 2);
    assert.deepEqual([gba.cpu.r[1] >>> 0, gba.cpu.r[3]], [0xffffc000, 0x8000]);
});

test("code changed just ahead of the PC still runs from the pipeline", () => {
    // In IWRAM: an STR overwrites the instruction two ahead (already fetched).
    const gba = new Gba(cart([0xe3a0f403])); // mov pc, #0x03000000
    const program = [
        0xe3a02000, // mov r2, #0
        0xe3a03001, // mov r3, #1
        0xe58f2000, // str r2, [pc]    (writes 0x10)
        0xe1a00000, // nop
        0xe3a03002, // mov r3, #2     <- overwritten, but already in the pipeline
        IDLE,
    ];
    const view = new DataView(gba.bus.iwram.buffer);
    program.forEach((word, i) => view.setUint32(i * 4, word, true));
    run(gba, 2);
    assert.equal(gba.cpu.r[3], 2);
    assert.equal(view.getUint32(0x10, true), 0);
});

test("write-only I/O registers read as open bus (the prefetched opcode)", () => {
    const gba = new Gba(cart([], { after: [0, 0xcafebabe] }));
    run(gba, 1);
    // The idle loop is at 0x080000C0; the opcode two ahead is the marker.
    assert.equal(gba.bus.read16(0x04000010), 0xbabe);
    assert.equal(gba.bus.read16(0x04000012), 0xcafe);
    // Readable registers mask their unused bits; unused gaps read 0.
    gba.write16(0x08, 0xffff);
    assert.equal(gba.bus.read16(0x04000008), 0xdfff);
    assert.equal(gba.bus.read16(0x04000066), 0);
});

test("KEYINPUT and the keypad interrupt", () => {
    const gba = new Gba(cart());
    run(gba, 1);
    gba.setInput(Button.A | Button.START);
    assert.equal(gba.read16(0x130), 0x3ff & ~(Button.A | Button.START));
    gba.write16(0x132, 0x4000 | 0x8000 | Button.A | Button.B); // IRQ when A and B are both held
    assert.equal(gba.irq.if & 0x1000, 0);
    gba.setInput(Button.A | Button.B);
    assert.equal(gba.irq.if & 0x1000, 0x1000);
});

test("timers: prescaler ticks on a shared clock, overflows reload and cascade", () => {
    let now = 100;
    const irqs = [];
    const timers = new Timers({
        now: () => now,
        requestIrq: (bit, time) => irqs.push([bit, time]),
        onOverflow: () => {},
        feedsSound: () => false,
        onSchedule: () => {},
    });
    timers.write16(0x100, 0xfffe); // reload
    timers.write16(0x102, 0x00c1); // on, IRQ, prescaler 64
    timers.write16(0x106, 0x0084); // timer 1 counts timer 0's overflows
    // Ticks fall on multiples of 64: the first at 128.
    now = 127;
    assert.equal(timers.read16(0x100), 0xfffe);
    now = 130;
    assert.equal(timers.read16(0x100), 0xffff);
    // The overflow (at 192) is an event: interrupt, reload, cascade.
    assert.equal(timers.nextEvent, 192);
    now = 200;
    timers.event(now);
    assert.deepEqual(irqs, [[3, 192]]);
    assert.equal(timers.read16(0x104), 1);
    now = 192 + 64 + 2;
    assert.equal(timers.read16(0x100), 0xffff);
});

test("sound: a Game Boy channel and a DMA-fed FIFO play at the right pitch", () => {
    const gba = new Gba(cart());
    run(gba, 1);
    const w = (address, value) => gba.write16(address, value);
    w(0x84, 0x80); // master on
    w(0x80, 0xff77); // all channels left and right, full volume
    w(0x82, 0x0002); // PSG at 100%
    w(0x68, 0xf080); // channel 2: 50% duty, volume 15
    w(0x6c, 0x8000 | 1750); // 131072 / (2048 - 1750) = 440 Hz
    let samples = collectAudio(gba, 30).slice(48000); // skip the first half second (filter settling)
    assert.ok(Math.abs(frequency(samples) - 440) < 5, `square at ${frequency(samples)} Hz`);

    // FIFO A: a 32-sample sawtooth at 16384 Hz (512 Hz), fed by DMA 1 from EWRAM.
    w(0x68, 0);
    for (let i = 0; i < 0x8000; i++) gba.bus.ewram[0x10000 + i] = ((i & 31) * 8 - 128) & 0xff;
    w(0x82, 0x0002 | 0x0004 | 0x0300 | 0x0800);
    gba.bus.write32(0x040000bc, 0x02010000);
    gba.bus.write32(0x040000c0, 0x040000a0);
    w(0xc6, 0xb640); // DMA 1: on, sound FIFO timing, 32-bit, repeat, fixed destination
    w(0x100, 0x10000 - 1024);
    w(0x102, 0x80);
    samples = collectAudio(gba, 30).slice(24000);
    assert.ok(Math.abs(frequency(samples) - 512) < 5, `sawtooth at ${frequency(samples)} Hz`);
    assert.ok(Math.max(...samples) > 0.5, "FIFO at full volume");
});

test("video capture DMA copies once per line on lines 2-161, then stops", () => {
    // Waits for line 170, then starts DMA 3: special timing, repeat, 16-bit,
    // one unit per line from EWRAM to IWRAM.
    const gba = new Gba(cart([
        0xe3a00404, 0xe2800006, // r0 = VCOUNT
        0xe1d010b0, 0xe35100aa, 0x1afffffc, // wait for line 170
        0xe3a02404, 0xe28220d4, // r2 = DMA3SAD
        0xe3a03402, 0xe5823000, // source 0x02000000
        0xe3a03403, 0xe5823004, // destination 0x03000000
        0xe3a034b2, 0xe3833001, 0xe5823008, // count 1, control 0xB200
    ]));
    for (let i = 0; i < 400; i++) gba.bus.ewram[i * 2] = i & 0xff;
    run(gba, 3);
    const copied = gba.bus.iwram16;
    assert.equal(copied[159], 159);
    assert.equal(copied[160], 0);
    assert.equal(gba.read16(0xde) & 0x8000, 0);
});

test("save memory type is detected from the SDK's ID string", () => {
    assert.equal(detectBackup(cart([], { extra: "FLASH1M_V103" })), BackupType.FLASH128);
    assert.equal(detectBackup(cart([], { extra: "FLASH512_V131" })), BackupType.FLASH64);
    assert.equal(detectBackup(cart([], { extra: "EEPROM_V124" })), BackupType.EEPROM);
    assert.equal(detectBackup(cart([], { extra: "SRAM_V113" })), BackupType.SRAM);
    assert.equal(detectBackup(cart()), BackupType.NONE);
});

/** Talks to the cartridge clock like the Pokémon games do. */
function rtc(gpio) {
    const pins = (value) => gpio.write(0xc4, value);
    const send = (byte, msbFirst) => {
        for (let i = 0; i < 8; i++) {
            const bit = (byte >> (msbFirst ? 7 - i : i)) & 1;
            pins((bit << 1) | 4);
            pins((bit << 1) | 5);
        }
    };
    const receive = () => {
        let byte = 0;
        for (let i = 0; i < 8; i++) {
            pins(4);
            pins(5);
            byte |= ((gpio.read(0xc4) >> 1) & 1) << i;
        }
        return byte;
    };
    return {
        command(command, write = [], read = 0) {
            gpio.write(0xc8, 1);
            gpio.write(0xc6, 7);
            pins(1);
            pins(5);
            send(command, true);
            for (const byte of write) send(byte, false);
            gpio.write(0xc6, 5);
            const out = Array.from({ length: read }, receive);
            gpio.write(0xc6, 7);
            pins(1);
            return out;
        },
    };
}

test("cartridge clock: date and time in BCD, following the wall clock", () => {
    let now = Date.UTC(2026, 9, 7, 14, 30, 5);
    const rom = cart([], { gameCode: "BPEE" });
    const gpio = new Gpio(rom, { now: () => now });
    assert.equal(gpio.present, true);
    const clock = rtc(gpio);
    assert.deepEqual(clock.command(0x63, [], 1), [0x40]); // status: 24-hour mode
    assert.deepEqual(clock.command(0x65, [], 7), [0x26, 0x10, 0x07, 0x03, 0x94, 0x30, 0x05]); // PM flag in the hour
    // Setting the clock keeps the offset; it rolls over into March of a leap year.
    clock.command(0x64, [0x24, 0x02, 0x29, 0x04, 0x23, 0x59, 0x50]);
    now += 15000;
    assert.deepEqual(clock.command(0x65, [], 7), [0x24, 0x03, 0x01, 0x05, 0x00, 0x00, 0x05]);
    // The offset is part of the saved game.
    const other = new Gpio(rom, { now: () => now });
    assert.equal(other.fromSave(gpio.toSave()), true);
    assert.deepEqual(rtc(other).command(0x67, [], 3), [0x00, 0x00, 0x05]);
    assert.equal(new Gpio(cart()).present, false);
});

test("snapshots restore the whole machine, sound and timers included", () => {
    const gba = new Gba(cart());
    run(gba, 1);
    gba.write16(0x84, 0x80);
    gba.write16(0x80, 0xff77);
    gba.write16(0x68, 0xf040);
    gba.write16(0x6c, 0x8000 | 1900);
    gba.write16(0x100, 0xff00);
    gba.write16(0x102, 0x00c2);
    gba.write16(0x200, 0x0008);
    run(gba, 5);
    const state = gba.saveState();
    const hash = (core) => {
        let h = 0;
        for (let i = 0; i < 20; i++) {
            core.runFrame();
            for (const v of core.getAudioSamples()) h = (h * 31 + Math.round(v * 1e6)) >>> 0;
            h = (h * 31 + core.timers.read16(0x100) + core.irq.if) >>> 0;
        }
        return h;
    };
    const expected = hash(gba);
    gba.loadState(state);
    assert.equal(hash(gba), expected);
    const fresh = new Gba(cart());
    fresh.loadState(state);
    assert.equal(hash(fresh), expected);
    assert.throws(() => new Gba(cart([0]).subarray(0, 0x800)).loadState(state), /different game/);
});

test("memory regions: RAM, I/O, video memory, ROM and save memory", () => {
    const gba = new Gba(cart([], { extra: "SRAM_V113" }));
    const regions = gba.getMemoryRegions();
    const byName = (name) => regions.find((r) => r.name.startsWith(name));
    const ewram = byName("Work RAM (on board)");
    assert.equal(ewram.base, 0x02000000);
    ewram.write(5, 0xab);
    assert.equal(gba.bus.read8(0x02000005), 0xab);

    const io = byName("I/O registers");
    io.write(0x200, 0x01);
    assert.equal(gba.irq.ie & 0xff, 0x01, "IE written through the registers");
    assert.equal(io.read(0x200), 0x01);
    assert.equal(io.read(0x0e0), -1, "unused register");

    const rom = byName("ROM");
    assert.equal(rom.write, null);
    assert.equal(rom.read(0xac), "T".charCodeAt(0));

    const save = byName("Save memory");
    assert.equal(save.name, "Save memory (SRAM)");
    const writes = gba.getSaveWrites();
    save.write(0, 0x12);
    assert.equal(gba.getSaveData()[0], 0x12);
    assert.notEqual(gba.getSaveWrites(), writes);
});

test("a BIOS file: intro or straight to the game, and snapshots that do not mix", () => {
    const bios = new Uint8Array(0x4000);
    const rom = cart();
    const intro = new Gba(rom, { bios, biosIntro: true });
    assert.equal(intro.cpu.pc, 0, "starts at the reset vector");
    const direct = new Gba(rom, { bios });
    assert.equal(direct.cpu.pc, 0x08000000, "starts at the game");
    const builtIn = new Gba(rom);
    assert.throws(() => builtIn.loadState(direct.saveState()), /with the BIOS file/);
    assert.throws(() => direct.loadState(builtIn.saveState()), /without the BIOS file/);
    direct.loadState(direct.saveState());
});

/** A ROM with the given game code, for the cartridge devices. */
function romWithCode(code) {
    return cart([], { gameCode: code });
}

test("Boktai solar sensor: more light, fewer clocks until pin 3 rises", () => {
    const clocks = (light) => {
        const gpio = new Gpio(romWithCode("U3IJ"));
        gpio.light = light;
        gpio.write(0xc8, 1);
        gpio.write(0xc6, 7);
        gpio.write(0xc4, 2); // reset
        gpio.write(0xc4, 0);
        for (let n = 1; n < 300; n++) {
            gpio.write(0xc4, 1);
            gpio.write(0xc4, 0);
            if (gpio.read(0xc4) & 8) return n;
        }
        return Infinity;
    };
    assert.ok(hasSolarAndClock("U3IJ"));
    assert.equal(clocks(0), 0xff - 0x16);
    assert.equal(clocks(10), 0xff - 0x16 - 183);
    assert.ok(clocks(5) < clocks(1));
});

function hasSolarAndClock(code) {
    const gpio = new Gpio(romWithCode(code));
    return gpio.present && gpio.solar && gpio.rtc;
}

test("WarioWare Twisted gyro: 16 bits per sample, centered at 0x6C0", () => {
    const read = (rotation) => {
        const gpio = new Gpio(romWithCode("RZWE"));
        gpio.rotation = rotation;
        gpio.write(0xc8, 1);
        gpio.write(0xc6, 0xb); // pins 0, 1 and the motor
        gpio.write(0xc4, 1); // sample
        gpio.write(0xc4, 2);
        let value = 0;
        for (let i = 0; i < 16; i++) {
            gpio.write(0xc4, 0); // falling edge of pin 1: a bit on pin 2
            value = (value << 1) | ((gpio.read(0xc4) >> 2) & 1);
            gpio.write(0xc4, 2);
        }
        return value;
    };
    assert.equal(read(0), 0x6c0);
    assert.equal(read(1), 0x6c0 + 0x300);
    assert.equal(read(-1), 0x6c0 - 0x300);
});

test("rumble: the share of time the motor ran", () => {
    let cycles = 0;
    const gpio = new Gpio(romWithCode("V49E"), { cycles: () => cycles });
    gpio.write(0xc6, 8);
    gpio.write(0xc4, 8);
    cycles = 30;
    gpio.write(0xc4, 0);
    cycles = 60;
    gpio.write(0xc4, 8);
    cycles = 100;
    assert.equal(gpio.rumbleLevel(0), 0.7);
    cycles = 200;
    assert.equal(gpio.rumbleLevel(100), 1, "still running");
});

test("Yoshi Topsy-Turvy accelerometer: sampled by writes in the save area", () => {
    const gba = new Gba(romWithCode("KYGE"));
    assert.ok(gba.wantsTilt);
    gba.setTilt(1, -0.5);
    gba.bus.write8(0x0e008000, 0x55);
    gba.bus.write8(0x0e008100, 0xaa);
    const x = gba.bus.read8(0x0e008200) | ((gba.bus.read8(0x0e008300) & 0xf) << 8);
    const y = gba.bus.read8(0x0e008400) | ((gba.bus.read8(0x0e008500) & 0xf) << 8);
    assert.equal(gba.bus.read8(0x0e008300) & 0x80, 0x80);
    assert.equal(x, 0x3a0 + 0x100);
    assert.equal(y, 0x3a0 - 0x80);
    // Snapshots keep the sample.
    const again = new Gba(romWithCode("KYGE"));
    again.loadState(gba.saveState());
    assert.equal(again.bus.read8(0x0e008200), x & 0xff);
});

// --- Idle loops ---------------------------------------------------------------------

/** Runs `rom` with idle-loop skipping on and off; both must end in the same state. */
function compareIdle(rom, frames) {
    const runs = [true, false].map((enabled) => {
        const gba = new Gba(rom);
        gba.idleLoops.enabled = enabled;
        run(gba, frames);
        return gba;
    });
    assert.deepEqual(runs[0].saveState(), runs[1].saveState(), "same state with and without skipping");
    return runs[0];
}

test("idle loops: a jump to itself is skipped up to each event", () => {
    const gba = compareIdle(cart(), 10);
    assert.ok(gba.idleLoops.skipped > gba.bus.cycles * 0.9, `${gba.idleLoops.skipped} of ${gba.bus.cycles}`);
});

test("idle loops: polling VCOUNT keeps its exact timing", () => {
    const gba = compareIdle(cart([
        0xe3a00301, // mov r0, #0x04000000
        0xe1d010b6, // loop: ldrh r1, [r0, #6] (VCOUNT)
        0xe3510064, // cmp r1, #100
        0x1afffffc, // bne loop
        0xe2822001, // add r2, r2, #1 (counts passes while on line 100)
        0xeafffffa, // b loop
    ]), 5);
    assert.ok(gba.cpu.r[2] > 0, "reached line 100");
    assert.ok(gba.idleLoops.skipped > gba.bus.cycles * 0.5, "most of the waiting skipped");
});

test("idle loops: reading a timer is never skipped", () => {
    const gba = compareIdle(cart([
        0xe3a00301, // mov r0, #0x04000000
        0xe2800c01, // add r0, r0, #0x100
        0xe1d010b0, // loop: ldrh r1, [r0] (TM0CNT_L)
        0xe3510001, // cmp r1, #1
        0x1afffffc, // bne loop
    ]), 2);
    assert.equal(gba.idleLoops.skipped, 0);
});

// --- Multiply carry --------------------------------------------------------------------

test("multiplies set the carry flag like the ARM7TDMI's Booth multiplier", async () => {
    const { Flavor, multiplyCarry } = await import("../src/core/gba/multiply-carry.js");
    // multiplicand, multiplier, accumulator low/high; then the carry of
    // MULS, MLAS, UMULLS, UMLALS, SMULLS, SMLALS (from the original C code).
    const cases = [
        [4294967164, 4788469, 13365, 4294967230, 1, 1, 1, 1, 1, 1],
        [4294967295, 4294967223, 4292094103, 4294967217, 0, 0, 1, 1, 0, 0],
        [481637726, 3734052113, 14100660, 4294967216, 0, 0, 0, 0, 0, 0],
        [7126788, 567320409, 1895931292, 2544403732, 0, 0, 0, 1, 0, 1],
        [2007660408, 4294967295, 4294967250, 4293462845, 0, 1, 1, 1, 0, 1],
        [3993104583, 1130860790, 2930825910, 4294967226, 0, 0, 0, 0, 1, 1],
        [1162808428, 3118703620, 4294967165, 4191866, 1, 1, 0, 0, 1, 1],
        [4294967040, 1718046902, 132, 25, 0, 0, 1, 1, 1, 1],
        [1465367256, 2566168983, 1876448115, 1131447678, 1, 1, 0, 0, 1, 0],
    ];
    for (const [a, b, lo, hi, ...carry] of cases) {
        assert.deepEqual([
            multiplyCarry(Flavor.SHORT, a, b), multiplyCarry(Flavor.SHORT, a, b, lo),
            multiplyCarry(Flavor.LONG_UNSIGNED, a, b), multiplyCarry(Flavor.LONG_UNSIGNED, a, b, lo, hi),
            multiplyCarry(Flavor.LONG_SIGNED, a, b), multiplyCarry(Flavor.LONG_SIGNED, a, b, lo, hi),
        ], carry, `${a} * ${b}`);
    }
    // UMULLS -1 * -1 sets C (mGBA's suite).
    const gba = new Gba(cart([
        0xe3e00000, // mvn r0, #0
        0xe3e01000, // mvn r1, #0
        0xe0932190, // umulls r2, r3, r0, r1
    ]));
    run(gba, 1);
    assert.deepEqual([gba.cpu.r[2] >>> 0, gba.cpu.r[3] >>> 0, gba.cpu.n, gba.cpu.c], [1, 0xfffffffe, 1, 1]);
});

// --- Link cable ------------------------------------------------------------------------

async function linkedPair() {
    const { createLinkedCore } = await import("../src/core/gba/index.js");
    const first = new Gba(cart());
    run(first, 3); // already running, so the clocks differ
    const linked = createLinkedCore(first, cart(), { system: "gba" }, {});
    return { linked, a: linked.machines[0], b: linked.machines[1] };
}

test("GBA games link with GBA games only", async () => {
    const { canLink } = await import("../src/core/registry.js");
    const gba = new Gba(cart());
    assert.equal(canLink(gba, { system: "gba" }), true);
    assert.equal(canLink(gba, { system: "gb" }), false);
    const { linked } = await linkedPair();
    assert.equal(canLink(linked, { system: "gba" }), false, "not a third one");
    assert.equal(linked.width, 480);
    linked.runFrame();
    assert.ok(linked.getAudioSamples().length > 0);
    assert.equal(linked.screenshot(1).width, 240);
});

test("link cable: a multiplayer transfer swaps both words and interrupts both", async () => {
    const { linked, a, b } = await linkedPair();
    for (const [gba, word] of [[a, 0x1234], [b, 0xabcd]]) {
        gba.write16(0x134, 0); // RCNT: SIO
        gba.write16(0x128, 0x6003); // multiplayer, 115200 bps, IRQ
        gba.write16(0x12a, word);
        gba.write16(0x200, 0x80); // IE: serial
    }
    assert.equal(a.read16(0x128) & 0x0c, 0x08, "parent: SI low, SD high");
    assert.equal(b.read16(0x128) & 0x0c, 0x0c, "child: SI high, SD high");
    b.write16(0x128, 0x6083);
    assert.equal(b.read16(0x128) & 0x80, 0, "only the parent starts");
    a.write16(0x128, 0x6083);
    assert.equal(b.read16(0x128) & 0x80, 0x80, "both busy");
    linked.runFrame();
    for (const [gba, id] of [[a, 0], [b, 1]]) {
        assert.deepEqual([0x120, 0x122, 0x124, 0x126].map((r) => gba.read16(r)), [0x1234, 0xabcd, 0xffff, 0xffff]);
        assert.equal(gba.read16(0x128) & 0xf0, id << 4, "done, with its ID");
        assert.equal(gba.irq.if & 0x80, 0x80, "serial interrupt");
    }
});

test("link cable: a multiplayer start written before the cable was plugged in goes ahead", async () => {
    const { createLinkedCore } = await import("../src/core/gba/index.js");
    const first = new Gba(cart());
    first.write16(0x134, 0);
    first.write16(0x128, 0x2003);
    first.write16(0x12a, 0x1234);
    first.write16(0x128, 0x2083);
    run(first, 1);
    assert.equal(first.read16(0x128) & 0x80, 0x80, "unplugged: busy for good");
    const linked = createLinkedCore(first, cart(), { system: "gba" }, {});
    linked.runFrame();
    assert.equal(first.read16(0x128) & 0x80, 0, "done");
    assert.deepEqual([0x120, 0x122].map((r) => first.read16(r)), [0x1234, 0xffff], "the child isn't in multiplayer mode");
});

test("link cable: a Normal-mode transfer swaps words with a slave that waits", async () => {
    const { linked, a, b } = await linkedPair();
    const setWord = (gba, word) => {
        gba.write16(0x120, word & 0xffff);
        gba.write16(0x122, word >>> 16);
    };
    const word = (gba) => (gba.read16(0x120) | (gba.read16(0x122) << 16)) >>> 0;
    for (const gba of [a, b]) gba.write16(0x128, 0x1000); // Normal 32-bit
    setWord(a, 0x12345678);
    setWord(b, 0xcafebabe);
    b.write16(0x128, 0x5080); // external clock, started, IRQ
    assert.equal(a.read16(0x128) & 4, 0, "master's SI: the slave is ready");
    a.write16(0x128, 0x5083); // internal clock, 2 MHz, start
    linked.runFrame();
    assert.equal(word(a), 0xcafebabe);
    assert.equal(word(b), 0x12345678);
    assert.equal((a.read16(0x128) | b.read16(0x128)) & 0x80, 0, "both done");
    // Without a waiting slave, the master reads the line's idle level.
    a.write16(0x128, 0x5083);
    linked.runFrame();
    assert.equal(word(a), 0xffffffff);
    assert.equal(word(b), 0x12345678, "the slave took no part");
});

test("link cable: UART sends bytes at the baud rate, through the FIFOs", async () => {
    const { linked, a, b } = await linkedPair();
    for (const gba of [a, b]) {
        gba.write16(0x134, 0); // RCNT: SIO
        gba.write16(0x128, 0x7f83); // UART, 115200 bps, 8 bits, FIFO, send + receive, IRQ
        gba.write16(0x200, 0x80);
    }
    assert.equal(b.read16(0x128) & 0x30, 0x20, "nothing received yet");
    for (const byte of [0x48, 0x69, 0x21, 0x0a]) a.write16(0x12a, byte);
    assert.equal(a.read16(0x128) & 0x10, 0x10, "send FIFO full");
    a.write16(0x12a, 0x99); // dropped
    linked.runFrame();
    assert.equal(a.read16(0x128) & 0x10, 0, "all sent");
    const received = [];
    while (!(b.read16(0x128) & 0x20)) received.push(b.read16(0x12a) & 0xff);
    assert.deepEqual(received, [0x48, 0x69, 0x21, 0x0a]);
    assert.equal(b.irq.if & 0x80, 0x80, "receive interrupt");
    // Without a link nothing changes: writes are ignored, the receiver stays empty.
    linked.unlink();
    a.write16(0x128, 0x7f83);
    a.write16(0x12a, 0x55);
    assert.equal(a.read16(0x128) & 0x30, 0x20);
});

// --- Multiboot -------------------------------------------------------------------------

/**
 * A multiboot program (0x1C0 bytes, loaded at 0x02000000): a header, the
 * entry point at 0x020000C0 jumping over the bytes the BIOS fills in, then
 * code that writes 0x42 at 0x03000000.
 */
function multibootProgram() {
    const program = new Uint8Array(0x1c0);
    const view = new DataView(program.buffer);
    view.setUint32(0, 0xea00002e, true); // b 0x020000C0
    view.setUint32(0xc0, 0xea000006, true); // b 0x020000E0
    [0xe3a00403, 0xe3a01042, 0xe5801000, IDLE].forEach((word, i) => view.setUint32(0xe0 + i * 4, word, true));
    return program;
}

async function cartlessPair() {
    const { createLinkedCore } = await import("../src/core/gba/index.js");
    const first = new Gba(cart());
    run(first, 3);
    const linked = createLinkedCore(first, null, { system: "gba" }, {});
    const [a, b] = linked.machines;
    a.write16(0x134, 0); // RCNT: SIO
    a.write16(0x128, 0x2003); // multiplayer, 115200 bps
    /** One multiplayer transfer from the parent; returns the child's word. */
    const send = (word) => {
        a.write16(0x12a, word);
        a.write16(0x128, 0x2083);
        linked.runFrame();
        assert.equal(a.read16(0x128) & 0x80, 0, "transfer done");
        return a.read16(0x122);
    };
    return { linked, a, b, send };
}

function crc(value, data) {
    for (let i = 0; i < 32; i++) {
        const bit = (value ^ data) & 1;
        data >>>= 1;
        value >>>= 1;
        if (bit) value ^= 0xa517;
    }
    return value;
}

/** Steps 1-8 of the multiboot handshake (as gba-link-connection's sender); returns the client's byte. */
function handshake(send, program, { confirm = true } = {}) {
    let reply = 0;
    for (let i = 0; i < 16 && reply !== 0x7202; i++) reply = send(0x6200);
    assert.equal(reply, 0x7202, "client 1 answers");
    assert.equal(send(0x6102), 0x7202);
    for (let i = 0; i < 0x60; i++) {
        assert.equal(send(program[i * 2] | (program[i * 2 + 1] << 8)), ((0x60 - i) << 8) | 2, "header");
    }
    if (confirm) {
        assert.equal(send(0x6200), 0x0002);
        assert.equal(send(0x6202), 0x7202);
    }
    for (let i = 0; i < 16 && (reply & 0xff00) !== 0x7300; i++) reply = send(0x63d1);
    assert.equal(reply & 0xff00, 0x7300, "client data");
    const clientData = reply & 0xff;
    const handshakeData = (0x11 + clientData + 0xff + 0xff) & 0xff;
    assert.equal(send(0x6400 | handshakeData) & 0xff00, 0x7300);
    return { clientData, handshakeData };
}

test("multiboot: a GBA without a cartridge waits, then runs the program the game sends", async () => {
    for (const confirm of [true, false]) {
        const { linked, a, b, send } = await cartlessPair();
        assert.equal(b.cartless, true);
        assert.equal(b.getSaveData(), null, "no saves");
        assert.equal(b.read16(0) & 0x80, 0x80, "forced blank while it waits");
        run(linked, 2);
        const program = multibootProgram();
        const { clientData, handshakeData } = handshake(send, program, { confirm });
        // The game sends the length and the encrypted words itself.
        const words = new DataView(program.buffer);
        const reply = send((program.length - 0x190) / 4);
        let seed = (0xd1 | (clientData << 8) | 0xffff0000) >>> 0;
        let check = 0xfff8;
        for (let i = 0xc0 / 4; i < program.length / 4; i++) {
            seed = (Math.imul(seed, 0x6f646573) + 1) >>> 0;
            const plain = words.getUint32(i * 4, true);
            const data = ((plain ^ (0xfe000000 - (i << 2)) ^ seed ^ 0x6465646f) >>> 0);
            assert.equal(send(data & 0xffff), (i << 2) & 0xffff);
            assert.equal(send(data >>> 16), ((i << 2) + 2) & 0xffff);
            check = crc(check, plain);
        }
        check = crc(check & 0xffff, (handshakeData | ((reply & 0xff) << 8) | 0xffff0000) >>> 0);
        send(0x65);
        assert.equal(send(0x65), 0x75, "ready for the CRC");
        send(0x66);
        assert.equal(send(check), check, "same CRC");
        run(linked, 1);
        assert.equal(b.bus.iwram[0], 0x42, "the program ran");
        assert.equal(b.bus.ewram[0xc4], 3, "multiplayer boot");
        assert.equal(b.read16(0) & 0x80, 0, "screen on");
    }
});

test("multiboot: SWI 0x25 sends the program to a client after the handshake", async () => {
    const { linked, a, b, send } = await cartlessPair();
    const program = multibootProgram();
    const param = 0x03000100;
    // MultiBootParam: boot_srcp/boot_endp point past the header, at the program in EWRAM.
    a.bus.ewram.set(program, 0x1000);
    a.bus.write32(param + 0x20, 0x02001000 + 0xc0);
    a.bus.write32(param + 0x24, 0x02001000 + program.length);
    assert.equal(a.multiBoot(param, 1), false, "no client yet");
    handshake(send, program);
    a.bus.write32(param + 0x24, 0x02001000 + program.length - 4);
    assert.equal(a.multiBoot(param, 1), false, "length not a multiple of 16");
    a.bus.write32(param + 0x24, 0x02001000 + program.length);
    const start = a.bus.cycles;
    assert.equal(a.multiBoot(param, 1), true);
    assert.ok(a.stallUntil > start + 64 * 2 * 6000, "the parent's BIOS is busy for the transfer");
    run(linked, 1);
    assert.equal(b.bus.iwram[0], 0, "not started before the transfer would end");
    run(linked, 2);
    assert.ok(a.bus.cycles >= a.stallUntil);
    assert.equal(b.bus.iwram[0], 0x42, "the program ran");
    assert.deepEqual([...b.bus.ewram.subarray(0, 0xc0)], [...program.subarray(0, 0xc0)], "header from the handshake");
    assert.deepEqual([...b.bus.ewram.subarray(0xc4, 0xc6)], [3, 1], "boot mode, client number");
});

test("multiboot: a wrong CRC sends the client back to waiting", async () => {
    const { linked, b, send } = await cartlessPair();
    const program = multibootProgram();
    handshake(send, program);
    send((program.length - 0x190) / 4);
    for (let i = 0xc0 / 4; i < program.length / 4; i++) {
        send(0);
        send(0);
    }
    send(0x65);
    send(0x65);
    const check = send(0x66);
    send(check ^ 1);
    run(linked, 2);
    assert.equal(b.bus.iwram[0], 0);
    assert.equal(b.multibootClient.ready, false);
    send(0x6200);
    assert.equal(send(0x6200), 0x7202, "waits for a new handshake");
});
