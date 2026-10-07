import assert from "node:assert/strict";
import { test } from "node:test";
import { Button } from "../src/core/buttons.js";
import { createCartridge } from "../src/core/gb/cartridge.js";
import { GameBoy } from "../src/core/gb/gameboy.js";
import { gbcCombinationFor } from "../src/core/gb/palettes.js";
import { makeGbRom } from "./helpers.js";

// Small hand-assembled programs (placed at 0x150 by makeGbRom).

test("runs instructions and writes work RAM", () => {
    const gb = new GameBoy(makeGbRom({
        code: [
            0x3e, 0x12, // LD A,$12
            0xea, 0x00, 0xc0, // LD ($C000),A
            0x47, // LD B,A
            0x80, // ADD A,B
            0xcb, 0x37, // SWAP A
            0xf5, // PUSH AF
            0xd1, // POP DE
            0x76, // HALT
            0x18, 0xfe, // JR -2
        ],
    }));
    gb.runFrame();
    assert.equal(gb.wram[0], 0x12);
    assert.equal(gb.cpu.a, 0x42);
    assert.equal(gb.cpu.d, 0x42);
    assert.equal(gb.cpu.halted, true);
});

test("timer interrupts wake the CPU from HALT", () => {
    const rom = makeGbRom({
        code: [
            0x3e, 0x04, 0xe0, 0xff, // IE = timer
            0x3e, 0x05, 0xe0, 0x07, // TAC = enabled, 262144 Hz
            0xaf, 0xe0, 0x0f, // IF = 0
            0xfb, // EI
            0x76, // HALT
            0x18, 0xfd, // JR back to HALT
        ],
    });
    rom.set([0x14, 0xd9], 0x50); // timer vector: INC D, RETI
    const gb = new GameBoy(rom);
    gb.runFrame();
    gb.runFrame();
    // TIMA overflows every 256 * 16 T-cycles: about 17 times per frame.
    assert.ok(gb.cpu.d >= 30 && gb.cpu.d <= 36, `D = ${gb.cpu.d}`);
});

test("joypad reads the selected button group and raises its interrupt", () => {
    const gb = new GameBoy(makeGbRom());
    gb.if = 0;
    gb.write(0xff00, 0x20); // D-pad
    gb.setInput(Button.RIGHT | Button.A);
    assert.equal(gb.read(0xff00), 0xee);
    assert.equal(gb.if & 0x10, 0x10);
    gb.write(0xff00, 0x10); // buttons
    assert.equal(gb.read(0xff00), 0xde);
});

test("save states restore video and audio exactly", () => {
    const gb = new GameBoy(makeGbRom({
        code: [
            0x3e, 0xf0, 0xe0, 0x17, // NR22: volume 15
            0x3e, 0x80, 0xe0, 0x16, // NR21: 50% duty
            0x3e, 0x00, 0xe0, 0x18, // NR23
            0x3e, 0x87, 0xe0, 0x19, // NR24: trigger
            0x21, 0x00, 0x80, // LD HL,$8000
            0x0e, 0x10, // LD C,16
            0x3e, 0xaa, // LD A,$AA
            0x22, // LD (HL+),A
            0x0d, // DEC C
            0x20, 0xfa, // JR NZ
            0xf0, 0x43, 0x3c, 0xe0, 0x43, // SCX++
            0x06, 0x00, 0x05, 0x20, 0xfd, // delay
            0x18, 0xf4, // JR back to SCX++
        ],
    }));
    for (let i = 0; i < 10; i++) gb.runFrame();
    const state = gb.saveState();

    const run = () => {
        const frames = [];
        for (let i = 0; i < 5; i++) {
            gb.runFrame();
            frames.push({ video: gb.getFrameBuffer().slice(), audio: gb.getAudioSamples().slice() });
        }
        return frames;
    };
    const expected = run();
    assert.ok(new Set(expected[4].video).size > 2, "something is drawn");
    assert.ok(expected[4].audio.some((s) => Math.abs(s) > 0.01), "something is audible");

    gb.loadState(state);
    assert.deepEqual(run(), expected);
});

test("rejects snapshots of other games and survives corrupt ones", () => {
    const gb = new GameBoy(makeGbRom());
    const other = new GameBoy(makeGbRom({ size: 0x10000 }));
    assert.throws(() => gb.loadState(other.saveState()), /different game/);

    gb.runFrame();
    const state = gb.saveState();
    const pc = gb.cpu.pc;
    assert.throws(() => gb.loadState(state.subarray(0, state.length - 100)), /Invalid/);
    assert.equal(gb.cpu.pc, pc);
});

test("rejects unsupported cartridge types", () => {
    assert.throws(() => new GameBoy(makeGbRom({ cartType: 0x21 })), /0x21 is not supported/);
});

// --- Cartridges -----------------------------------------------------------------

function bankedRom(cartType, banks, ramSize = 0) {
    const rom = makeGbRom({ cartType, size: banks * 0x4000, ramSize });
    for (let bank = 0; bank < banks; bank++) rom[bank * 0x4000 + 0x2000] = bank;
    return rom;
}

test("MBC1 switches ROM and RAM banks", () => {
    const cart = createCartridge(bankedRom(0x03, 16, 3));
    assert.equal(cart.readRom(0x6000), 1);
    cart.writeRom(0x2000, 5);
    assert.equal(cart.readRom(0x6000), 5);
    cart.writeRom(0x2000, 0);
    assert.equal(cart.readRom(0x6000), 1, "bank 0 maps to 1");
    cart.writeRom(0x2000, 0x13);
    assert.equal(cart.readRom(0x6000), 3, "masked to the ROM size");

    assert.equal(cart.readRam(0xa000), 0xff, "RAM disabled");
    cart.writeRom(0x0000, 0x0a);
    cart.writeRam(0xa000, 0x42);
    cart.writeRom(0x6000, 1); // RAM banking mode
    cart.writeRom(0x4000, 1);
    cart.writeRam(0xa000, 0x43);
    const save = cart.getSaveData();
    assert.equal(save.length, 0x8000);
    assert.deepEqual([save[0], save[0x2000]], [0x42, 0x43]);

    const restored = createCartridge(bankedRom(0x03, 16, 3));
    restored.loadSaveData(save.slice());
    restored.writeRom(0x0000, 0x0a);
    assert.equal(restored.readRam(0xa000), 0x42);
});

test("MBC5 reaches bank 0 and the ninth bank bit", () => {
    const cart = createCartridge(bankedRom(0x19, 512));
    cart.writeRom(0x2000, 0x1f);
    cart.writeRom(0x3000, 1);
    assert.equal(cart.readRom(0x6000), 0x11f & 0xff);
    cart.writeRom(0x2000, 0);
    cart.writeRom(0x3000, 0);
    assert.equal(cart.readRom(0x6000), 0);
    assert.equal(cart.getSaveData(), null, "no battery");
});

test("MBC2 has 512 half-bytes of RAM", () => {
    const cart = createCartridge(bankedRom(0x06, 8));
    cart.writeRom(0x0000, 0x0a);
    cart.writeRam(0xa000, 0xab);
    assert.equal(cart.readRam(0xa200), 0xfb, "mirrored, upper nibble reads 1");
    cart.writeRom(0x0100, 3); // address bit 8 selects the ROM bank
    assert.equal(cart.readRom(0x6000), 3);
    assert.equal(cart.getSaveData().length, 512);
});

test("MBC3 clock follows the wall clock and survives saving", () => {
    let now = Date.UTC(2026, 0, 1);
    const cart = createCartridge(bankedRom(0x10, 8, 3), { now: () => now });
    cart.writeRom(0x0000, 0x0a);
    const read = (register) => {
        cart.writeRom(0x4000, register);
        return cart.readRam(0xa000);
    };
    const latch = () => {
        cart.writeRom(0x6000, 0);
        cart.writeRom(0x6000, 1);
    };

    now += (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000;
    latch();
    assert.deepEqual([read(8), read(9), read(10), read(11)], [5, 4, 3, 2]);

    // Setting the clock, then leaving the game for an hour.
    cart.writeRom(0x4000, 0x0a);
    cart.writeRam(0xa000, 20);
    const save = cart.getSaveData();
    assert.equal(save.length, 0x8000 + 48);
    assert.deepEqual(cart.getSaveData(), save, "save data is stable while the clock runs");

    now += 3600 * 1000;
    const later = createCartridge(bankedRom(0x10, 8, 3), { now: () => now });
    later.loadSaveData(save);
    later.writeRom(0x0000, 0x0a);
    later.writeRom(0x6000, 0);
    later.writeRom(0x6000, 1);
    later.writeRom(0x4000, 0x0a);
    assert.equal(later.readRam(0xa000), 21);
});

test("picks the Game Boy Color palette of known Nintendo titles", () => {
    const tetris = makeGbRom({ title: "TETRIS" });
    assert.equal(gbcCombinationFor(tetris), -1, "not published by Nintendo");
    tetris[0x14b] = 0x01;
    assert.equal(gbcCombinationFor(tetris), 3);

    const gb = new GameBoy(tetris);
    gb.configure({ gbPalette: "auto" });
    assert.equal(gb.ppu.dmgBg[1], 0xff00ffff, "yellow");
    gb.configure({ gbPalette: "gray" });
    assert.equal(gb.ppu.dmgBg[0], 0xffffffff);

    // Unknown games get the Game Boy Color's default: different BG and sprite colors.
    const other = new GameBoy(makeGbRom());
    other.configure({ gbPalette: "gbc" });
    assert.notDeepEqual([...other.ppu.dmgBg], [...other.ppu.dmgObj0]);
});

test("MBC7 reads the tilt sensor and stores the saved game in its EEPROM", () => {
    const cart = createCartridge(bankedRom(0x22, 8));
    cart.writeRom(0x0000, 0x0a);
    cart.writeRom(0x4000, 0x40);
    cart.tiltX = 1; // one g to the right
    cart.writeRam(0xa000, 0x55);
    cart.writeRam(0xa010, 0xaa);
    assert.equal(cart.readRam(0xa020) | (cart.readRam(0xa030) << 8), 0x81d0 - 0x70);
    assert.equal(cart.readRam(0xa040) | (cart.readRam(0xa050) << 8), 0x81d0);

    // Bit-bang EEPROM commands: start bit, opcode, address, data (MSB first).
    const pins = (cs, clk, di) => cart.writeRam(0xa080, (cs ? 0x80 : 0) | (clk ? 0x40 : 0) | (di ? 2 : 0));
    const send = (bits) => {
        for (const bit of bits) {
            pins(1, 0, bit);
            pins(1, 1, bit);
        }
    };
    const command = (bits) => {
        pins(0, 0, 0);
        pins(1, 0, 0);
        send([1, ...bits]);
    };
    const word = (value) => [...Array(16)].map((_, i) => (value >> (15 - i)) & 1);
    command([0, 0, 1, 1, 0, 0, 0, 0, 0, 0]); // EWEN
    command([0, 1, 0, 0, 0, 0, 0, 0, 1, 1, ...word(0xbeef)]); // WRITE word 3
    assert.deepEqual([...cart.getSaveData().slice(6, 8)], [0xef, 0xbe]);

    command([1, 0, 0, 0, 0, 0, 0, 0, 1, 1]); // READ word 3
    let value = 0;
    for (let i = 0; i < 16; i++) {
        pins(1, 0, 0);
        pins(1, 1, 0);
        value = (value << 1) | (cart.readRam(0xa080) & 1);
    }
    assert.equal(value, 0xbeef);
});

test("HuC3 clock answers through its command mailbox", () => {
    let now = 0;
    const cart = createCartridge(bankedRom(0xfe, 8, 3), { now: () => now });
    const run = (value) => {
        cart.writeRom(0x0000, 0x0b);
        cart.writeRam(0xa000, value);
        cart.writeRom(0x0000, 0x0c);
        return cart.readRam(0xa000) & 0x0f;
    };
    now = (3 * 1440 + 125) * 60000; // day 3, 02:05
    run(0x40);
    run(0x50); // address 0
    const nibbles = [...Array(7)].map(() => run(0x10));
    assert.deepEqual(nibbles, [125 & 15, (125 >> 4) & 15, 0, 3, 0, 0, 0]);
    run(0x62);
    assert.equal(run(0x00) & 1, 1, "status request answers 1");
});

test("MMM01 starts in its menu and maps the selected game", () => {
    const rom = bankedRom(0x00, 16);
    rom.set(rom.subarray(0x104, 0x134), 14 * 0x4000 + 0x104);
    rom[14 * 0x4000 + 0x147] = 0x0d;
    const cart = createCartridge(rom);
    assert.equal(cart.constructor.name, "Mmm01");
    assert.equal(cart.readRom(0x6000), 15, "menu: last bank");
    cart.writeRom(0x2000, 0x04); // game at bank 4
    cart.writeRom(0x6000, 0x1c); // 32 KiB games: mask the upper bank bits
    cart.writeRom(0x0000, 0x40); // map
    assert.equal(cart.readRom(0x2000), 4, "game bank 0");
    assert.equal(cart.readRom(0x6000), 5, "game bank 1");
    cart.writeRom(0x2000, 0x00);
    assert.equal(cart.readRom(0x6000), 5, "selection bits are locked");
});

test("MBC6 maps two ROM windows and programs flash", () => {
    const cart = createCartridge(makeGbRom({ cartType: 0x20, size: 0x20000 }));
    cart.rom[3 * 0x2000] = 0x33;
    cart.writeRom(0x2000, 3);
    assert.equal(cart.readRom(0x4000), 0x33);
    cart.writeRom(0x0c00, 1); // flash on
    cart.writeRom(0x2800, 8); // window A shows flash
    cart.writeRom(0x2000, 2);
    const unlock = () => {
        cart.writeRom(0x2000, 2);
        cart.writeRom(0x5555, 0xaa);
        cart.writeRom(0x2000, 1);
        cart.writeRom(0x4aaa, 0x55);
        cart.writeRom(0x2000, 2);
    };
    unlock();
    cart.writeRom(0x5555, 0xa0); // program
    cart.writeRom(0x2000, 9);
    cart.writeRom(0x4010, 0x42);
    cart.writeRom(0x4010, 0xf0); // exit
    assert.equal(cart.readRom(0x4010), 0x42);
    assert.equal(cart.getSaveData()[0x8000 + 9 * 0x2000 + 0x10], 0x42);
});

test("Game Boy Camera captures the host image into tiles", () => {
    const gb = new GameBoy(makeGbRom({ cartType: 0xfc, size: 0x20000 }));
    assert.equal(gb.wantsCamera, true);
    const { width, height } = gb.cameraSize;
    gb.setCameraImage(new Uint8Array(width * height).fill(255));
    const cart = gb.cart;
    cart.writeRom(0x4000, 0x10); // registers
    cart.writeRam(0xa002, 0x03); // exposure
    for (let i = 0; i < 16; i++) {
        cart.writeRam(0xa006 + i * 3, 0x40);
        cart.writeRam(0xa007 + i * 3, 0x80);
        cart.writeRam(0xa008 + i * 3, 0xc0);
    }
    cart.writeRam(0xa000, 1);
    assert.equal(cart.readRam(0xa000) & 1, 1, "busy");
    for (let i = 0; i < 4; i++) gb.runFrame(); // about 2.6 frames at this exposure
    assert.equal(cart.readRam(0xa000) & 1, 0, "done");
    cart.writeRom(0x4000, 0);
    assert.ok(cart.ram.slice(0x100, 0x100 + 14 * 16 * 16).some((v) => v !== 0), "tiles written");
});

test("TAMA5 reaches its RAM through register writes", () => {
    const cart = createCartridge(bankedRom(0xfd, 8));
    const reg = (index, value) => {
        cart.writeRam(0xa001, index);
        cart.writeRam(0xa000, value);
    };
    reg(4, 0x2); // write value low
    reg(5, 0xa); // write value high
    reg(6, 0x0); // RAM write, address high
    reg(7, 0x5); // address low: performs the write
    assert.equal(cart.ram[5], 0xa2);
    reg(6, 0x2); // RAM read
    reg(7, 0x5);
    cart.writeRam(0xa001, 0x0c);
    assert.equal(cart.readRam(0xa000) & 0x0f, 0x2);
    cart.writeRam(0xa001, 0x0d);
    assert.equal(cart.readRam(0xa000) & 0x0f, 0xa);
});

test("reports rumble strength per frame", () => {
    const gb = new GameBoy(makeGbRom({
        cartType: 0x1c,
        code: [0x3e, 0x08, 0xea, 0x00, 0x40, 0x76, 0x18, 0xfd], // motor on, then HALT
    }));
    gb.runFrame();
    gb.runFrame();
    assert.equal(gb.getRumble(), 1);
});

test("a link cable swaps bytes between two Game Boys", async () => {
    const { LinkedGameBoys } = await import("../src/core/gb/link.js");
    const program = (byte, control) => makeGbRom({
        code: [
            0x3e, byte, 0xe0, 0x01, // SB = byte
            0x3e, control, 0xe0, 0x02, // SC: start (internal clock on the master)
            0xf0, 0x02, 0xcb, 0x7f, 0x20, 0xfa, // wait for the transfer
            0xf0, 0x01, 0xea, 0x00, 0xc0, // ($C000) = received byte
            0x76, 0x18, 0xfe,
        ],
    });
    const master = new GameBoy(program(0x42, 0x81));
    const slave = new GameBoy(program(0x99, 0x80));
    const link = new LinkedGameBoys(master, slave);
    for (let i = 0; i < 3; i++) link.runFrame();
    assert.equal(master.wram[0], 0x99);
    assert.equal(slave.wram[0], 0x42);
    assert.equal(link.getFrameBuffer().length, 320 * 144 * 4);

    link.setInput(0x01 | (0x08 << 16)); // A for player 1, Start for player 2
    assert.equal(master.joypad.buttons, 0x01);
    assert.equal(slave.joypad.buttons, 0x08);
    const state = link.saveState();
    link.loadState(state);
});

// --- Super Game Boy --------------------------------------------------------------

function sgbRom() {
    const rom = makeGbRom({ title: "SGBTEST", code: [0x18, 0xfe] }); // JR -2
    rom[0x146] = 0x03;
    rom[0x14b] = 0x33;
    return rom;
}

/** Sends SGB packets through P1, as games do. */
function sendSgb(gb, bytes) {
    const packets = Math.ceil(bytes.length / 16);
    const data = new Uint8Array(packets * 16);
    data.set(bytes);
    for (let p = 0; p < packets; p++) {
        gb.write(0xff00, 0x30);
        gb.write(0xff00, 0x00);
        gb.write(0xff00, 0x30);
        for (let i = 0; i < 128; i++) {
            const bit = (data[p * 16 + (i >> 3)] >> (i & 7)) & 1;
            gb.write(0xff00, bit ? 0x10 : 0x20);
            gb.write(0xff00, 0x30);
        }
        gb.write(0xff00, 0x20); // stop bit
        gb.write(0xff00, 0x30);
    }
}

test("Super Game Boy games get a border, SGB timing and their palettes", async () => {
    const { createCore } = await import("../src/core/gb/index.js");
    const info = { system: "gb" };
    const gb = createCore(sgbRom(), info, {});
    assert.ok(gb.sgb);
    assert.deepEqual([gb.width, gb.height], [256, 224]);
    assert.ok(gb.fps > 61 && gb.fps < 61.3);
    gb.configure({ sgbBorder: false });
    assert.deepEqual([gb.width, gb.height], [160, 144]);
    assert.equal(createCore(sgbRom(), info, { sgb: false }).sgb, null);
    assert.equal(createCore(makeGbRom(), info, {}).sgb, null);

    // PAL01: color 0 red, palette 0 colors 1-3, palette 1 colors 1-3.
    const colors = [0x001f, 0x03e0, 0x7c00, 0x7fff, 0x0010, 0x0200, 0x4000];
    sendSgb(gb, [0x01, ...colors.flatMap((c) => [c & 0xff, c >> 8])]);
    // ATTR_DIV: the right half (x >= 10, the division line included) uses palette 1.
    sendSgb(gb, [(0x06 << 3) | 1, 0b00_01_00_01, 10]);
    gb.runFrame();
    const screen = new Uint32Array(gb.getScreenBuffer().buffer);
    // The LCD shows shade 0 (BGP $FC, empty tiles): color 0, shared by all palettes.
    assert.equal(screen[0] & 0xffffff, 0x0000ff);
    assert.equal(screen[159] & 0xffffff, 0x0000ff);
    assert.equal(gb.sgb.palettes[5], 0x0010);
    assert.equal(gb.sgb.attributes[9], 0);
    assert.equal(gb.sgb.attributes[10], 1);
});

test("Super Game Boy multiplayer: MLT_REQ and the joypad ID", () => {
    const gb = new GameBoy(sgbRom(), { sgb: true });
    assert.equal(gb.players, 1);
    sendSgb(gb, [(0x11 << 3) | 1, 0x01]);
    assert.equal(gb.players, 2);
    gb.write(0xff00, 0x30);
    assert.equal(gb.read(0xff00) & 0x0f, 0x0f);
    // P15 low then high selects the next controller.
    gb.write(0xff00, 0x10);
    gb.write(0xff00, 0x30);
    assert.equal(gb.read(0xff00) & 0x0f, 0x0e);
    gb.setInput(Button.A << 16);
    gb.write(0xff00, 0x10);
    assert.equal(gb.read(0xff00) & 0x0f, 0x0e, "player 2 presses A");
});

test("Super Game Boy reads border tiles off the screen (CHR_TRN)", () => {
    const gb = new GameBoy(sgbRom(), { sgb: true });
    sendSgb(gb, [(0x13 << 3) | 1, 0x00]);
    // Shade 3 everywhere: every bitplane byte reads FF.
    const shades = new Uint32Array(160 * 144).fill(3);
    for (let i = 0; i < 3; i++) gb.sgb.render(shades);
    assert.ok(gb.sgb.borderTiles.subarray(0, 4096).every((b) => b === 0xff));
    assert.ok(gb.sgb.borderTiles.subarray(4096).every((b) => b === 0));
});

test("Super Game Boy state survives snapshots", () => {
    const gb = new GameBoy(sgbRom(), { sgb: true });
    sendSgb(gb, [(0x17 << 3) | 1, 0x02]); // MASK_EN black
    const state = gb.saveState();
    const other = new GameBoy(sgbRom(), { sgb: true });
    other.loadState(state);
    assert.equal(other.sgb.mask, 2);
    assert.throws(() => new GameBoy(sgbRom()).loadState(state));
});

test("a running Game Boy can take a link cable; a linked pair cannot", async () => {
    const { canLink } = await import("../src/core/registry.js");
    const { createLinkedCore } = await import("../src/core/gb/index.js");
    const info = { system: "gb" };
    const gb = new GameBoy(makeGbRom());
    assert.equal(canLink(gb, info), true);
    assert.equal(canLink(gb, { system: "gba" }), false);
    const linked = createLinkedCore(gb, makeGbRom(), info, {});
    assert.equal(canLink(linked, info), false);
});

test("APU zombie mode: writing $08 to NRx2 while playing adds 1 to the volume", () => {
    const gb = new GameBoy(makeGbRom());
    gb.write(0xff17, 0x58); // channel 2: volume 5, increase, no envelope steps
    gb.write(0xff19, 0x80); // trigger
    gb.write(0xff17, 0x08);
    assert.equal(gb.apu.square[1].currentVolume, 6);
    gb.write(0xff17, 0x08);
    assert.equal(gb.apu.square[1].currentVolume, 7);
});

// --- Memory viewer ----------------------------------------------------------------

test("memory regions: CPU view, banked memory, cartridge RAM", () => {
    const gb = new GameBoy(bankedRom(0x1b, 8, 3), { cgb: true });
    const regions = gb.getMemoryRegions();
    const byName = (name) => regions.find((r) => r.name.startsWith(name));
    const bus = byName("CPU address space");
    assert.equal(bus.size, 0x10000);
    bus.write(0xc123, 0x5a);
    assert.equal(gb.wram[0x123], 0x5a);
    assert.equal(bus.read(0xc123), 0x5a);
    assert.equal(bus.read(0xfeb0), -1, "unusable area");
    // Writes go through the bus: the mapper switches the ROM bank.
    bus.write(0x2000, 3);
    assert.equal(bus.read(0x6000), 3);
    // The CPU view reads VRAM even while the PPU would lock it.
    gb.ppu.vram[0x10] = 0x77;
    gb.ppu.vramReadBlocked = true;
    assert.equal(bus.read(0x8010), 0x77);

    const wram = byName("Work RAM");
    assert.equal(wram.size, 0x8000);
    wram.write(0x7fff, 0x42);
    assert.equal(gb.wram[0x7fff], 0x42);

    const palettes = byName("Background palettes");
    palettes.write(0, 0x1f);
    palettes.write(1, 0);
    assert.equal(gb.ppu.bgPaletteRam[0], 0x1f);

    const ram = byName("Cartridge RAM");
    assert.equal(ram.size, 0x8000);
    const writes = gb.getSaveWrites();
    ram.write(0x2001, 0x99);
    assert.equal(gb.cart.ram[0x2001], 0x99);
    assert.notEqual(gb.getSaveWrites(), writes, "edits get saved");
});

test("memory regions: a DMG without cartridge RAM has only the CPU view", () => {
    const regions = new GameBoy(makeGbRom()).getMemoryRegions();
    assert.deepEqual(regions.map((r) => r.name), ["CPU address space"]);
});
