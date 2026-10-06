import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Button } from '../src/core/buttons.js';
import { createCartridge } from '../src/core/gb/cartridge.js';
import { GameBoy } from '../src/core/gb/gameboy.js';
import { makeGbRom } from './helpers.js';

// Small hand-assembled programs (placed at 0x150 by makeGbRom).

test('runs instructions and writes work RAM', () => {
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

test('timer interrupts wake the CPU from HALT', () => {
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

test('joypad reads the selected button group and raises its interrupt', () => {
  const gb = new GameBoy(makeGbRom());
  gb.if = 0;
  gb.write(0xff00, 0x20); // D-pad
  gb.setInput(Button.RIGHT | Button.A);
  assert.equal(gb.read(0xff00), 0xee);
  assert.equal(gb.if & 0x10, 0x10);
  gb.write(0xff00, 0x10); // buttons
  assert.equal(gb.read(0xff00), 0xde);
});

test('save states restore video and audio exactly', () => {
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
  assert.ok(new Set(expected[4].video).size > 2, 'something is drawn');
  assert.ok(expected[4].audio.some((s) => Math.abs(s) > 0.01), 'something is audible');

  gb.loadState(state);
  assert.deepEqual(run(), expected);
});

test('rejects snapshots of other games and survives corrupt ones', () => {
  const gb = new GameBoy(makeGbRom());
  const other = new GameBoy(makeGbRom({ size: 0x10000 }));
  assert.throws(() => gb.loadState(other.saveState()), /different game/);

  gb.runFrame();
  const state = gb.saveState();
  const pc = gb.cpu.pc;
  assert.throws(() => gb.loadState(state.subarray(0, state.length - 100)), /Invalid/);
  assert.equal(gb.cpu.pc, pc);
});

test('rejects unsupported cartridge types', () => {
  assert.throws(() => new GameBoy(makeGbRom({ cartType: 0xfc })), /0xfc is not supported/);
});

// --- Cartridges -----------------------------------------------------------------

function bankedRom(cartType, banks, ramSize = 0) {
  const rom = makeGbRom({ cartType, size: banks * 0x4000, ramSize });
  for (let bank = 0; bank < banks; bank++) rom[bank * 0x4000 + 0x2000] = bank;
  return rom;
}

test('MBC1 switches ROM and RAM banks', () => {
  const cart = createCartridge(bankedRom(0x03, 16, 3));
  assert.equal(cart.readRom(0x6000), 1);
  cart.writeRom(0x2000, 5);
  assert.equal(cart.readRom(0x6000), 5);
  cart.writeRom(0x2000, 0);
  assert.equal(cart.readRom(0x6000), 1, 'bank 0 maps to 1');
  cart.writeRom(0x2000, 0x13);
  assert.equal(cart.readRom(0x6000), 3, 'masked to the ROM size');

  assert.equal(cart.readRam(0xa000), 0xff, 'RAM disabled');
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

test('MBC5 reaches bank 0 and the ninth bank bit', () => {
  const cart = createCartridge(bankedRom(0x19, 512));
  cart.writeRom(0x2000, 0x1f);
  cart.writeRom(0x3000, 1);
  assert.equal(cart.readRom(0x6000), 0x11f & 0xff);
  cart.writeRom(0x2000, 0);
  cart.writeRom(0x3000, 0);
  assert.equal(cart.readRom(0x6000), 0);
  assert.equal(cart.getSaveData(), null, 'no battery');
});

test('MBC2 has 512 half-bytes of RAM', () => {
  const cart = createCartridge(bankedRom(0x06, 8));
  cart.writeRom(0x0000, 0x0a);
  cart.writeRam(0xa000, 0xab);
  assert.equal(cart.readRam(0xa200), 0xfb, 'mirrored, upper nibble reads 1');
  cart.writeRom(0x0100, 3); // address bit 8 selects the ROM bank
  assert.equal(cart.readRom(0x6000), 3);
  assert.equal(cart.getSaveData().length, 512);
});

test('MBC3 clock follows the wall clock and survives saving', () => {
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
  assert.deepEqual(cart.getSaveData(), save, 'save data is stable while the clock runs');

  now += 3600 * 1000;
  const later = createCartridge(bankedRom(0x10, 8, 3), { now: () => now });
  later.loadSaveData(save);
  later.writeRom(0x0000, 0x0a);
  later.writeRom(0x6000, 0);
  later.writeRom(0x6000, 1);
  later.writeRom(0x4000, 0x0a);
  assert.equal(later.readRam(0xa000), 21);
});
