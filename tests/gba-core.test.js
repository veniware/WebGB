// GBA core unit tests: hand-assembled programs and the components on their own.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCore } from '../src/core/registry.js';
import { BackupType, detectBackup } from '../src/core/gba/backup.js';
import { Gba } from '../src/core/gba/gba.js';
import { Gpio } from '../src/core/gba/gpio.js';
import { Timers } from '../src/core/gba/timers.js';
import { Button } from '../src/core/buttons.js';

const IDLE = 0xeafffffe; // b .

/**
 * A cartridge: a jump over the header to `code` (ARM words at 0x080000C0),
 * then an idle loop followed by `after` words.
 */
function cart(code = [], { gameCode = 'TEST', after = [], extra = '' } = {}) {
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

test('the registry runs GBA games on the GBA core', async () => {
  const { core, fallback } = await createCore(cart(), { system: 'gba' });
  assert.equal(fallback, false);
  assert.equal(core.id, 'gba');
  assert.deepEqual([core.width, core.height], [240, 160]);
});

test('BIOS calls leave the BIOS\'s values in the other registers', () => {
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

test('code changed just ahead of the PC still runs from the pipeline', () => {
  // In IWRAM: an STR overwrites the instruction two ahead (already fetched).
  const gba = new Gba(cart([0xe3a0f403])); // mov pc, #0x03000000
  const program = [
    0xe3a02000, // mov r2, #0
    0xe3a03001, // mov r3, #1
    0xe58f2000, // str r2, [pc]  (writes 0x10)
    0xe1a00000, // nop
    0xe3a03002, // mov r3, #2   <- overwritten, but already in the pipeline
    IDLE,
  ];
  const view = new DataView(gba.bus.iwram.buffer);
  program.forEach((word, i) => view.setUint32(i * 4, word, true));
  run(gba, 2);
  assert.equal(gba.cpu.r[3], 2);
  assert.equal(view.getUint32(0x10, true), 0);
});

test('write-only I/O registers read as open bus (the prefetched opcode)', () => {
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

test('KEYINPUT and the keypad interrupt', () => {
  const gba = new Gba(cart());
  run(gba, 1);
  gba.setInput(Button.A | Button.START);
  assert.equal(gba.read16(0x130), 0x3ff & ~(Button.A | Button.START));
  gba.write16(0x132, 0x4000 | 0x8000 | Button.A | Button.B); // IRQ when A and B are both held
  assert.equal(gba.irq.if & 0x1000, 0);
  gba.setInput(Button.A | Button.B);
  assert.equal(gba.irq.if & 0x1000, 0x1000);
});

test('timers: prescaler ticks on a shared clock, overflows reload and cascade', () => {
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

test('sound: a Game Boy channel and a DMA-fed FIFO play at the right pitch', () => {
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
  assert.ok(Math.max(...samples) > 0.5, 'FIFO at full volume');
});

test('video capture DMA copies once per line on lines 2-161, then stops', () => {
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

test('save memory type is detected from the SDK\'s ID string', () => {
  assert.equal(detectBackup(cart([], { extra: 'FLASH1M_V103' })), BackupType.FLASH128);
  assert.equal(detectBackup(cart([], { extra: 'FLASH512_V131' })), BackupType.FLASH64);
  assert.equal(detectBackup(cart([], { extra: 'EEPROM_V124' })), BackupType.EEPROM);
  assert.equal(detectBackup(cart([], { extra: 'SRAM_V113' })), BackupType.SRAM);
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

test('cartridge clock: date and time in BCD, following the wall clock', () => {
  let now = Date.UTC(2026, 9, 7, 14, 30, 5);
  const rom = cart([], { gameCode: 'BPEE' });
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

test('snapshots restore the whole machine, sound and timers included', () => {
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
