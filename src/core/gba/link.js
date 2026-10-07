import { renamed } from "../memory.js";
import { StateReader, StateWriter } from "../state.js";
import { FRAME_CYCLES } from "./gba.js";
import { SCREEN_HEIGHT, SCREEN_WIDTH } from "./ppu.js";

const STATE_MAGIC = 0x4b4e4c47; // "GLNK"
// Cycles each machine runs before the other catches up. Shorter than the
// fastest multiplayer transfer, so the parent never finishes one before the
// child has seen it start; Normal-mode transfers at 2 MHz can end up to a
// slice late on the other side.
const SLICE_CYCLES = 256;
// Player 2's buttons in the input bitmask.
export const PLAYER_2_SHIFT = 16;

/**
 * Two GBAs connected by a link cable, presented to the host as one core:
 * both screens side by side (or stacked), both sounds mixed, player 2's
 * buttons in the upper 16 bits. Player 1 is the parent (the cable's purple
 * end). Player 2 can be a GBA without a cartridge, booted over the cable
 * (multiboot.js). The machines run in turn, a slice at a time, each on its own clock
 * (they started at different times); the serial ports convert times with
 * the difference.
 */
export class LinkedGbas {
    id = "gba-link";
    version = 1;
    players = 2;

    /**
     * @param {import("./gba.js").Gba} first Usually the game already running.
     * @param {import("./gba.js").Gba} second
     * @param {{ vertical?: boolean }} [options] Stack the screens instead of side by side.
     */
    constructor(first, second, { vertical = false } = {}) {
        this.machines = [first, second];
        this.fps = first.fps;
        this.sampleRate = first.sampleRate;
        this.vertical = vertical;
        this.width = vertical ? SCREEN_WIDTH : SCREEN_WIDTH * 2;
        this.height = vertical ? SCREEN_HEIGHT * 2 : SCREEN_HEIGHT;
        this.frame = new Uint8ClampedArray(this.width * this.height * 4);
        this.pixels = new Uint32Array(this.frame.buffer);
        this.audio = new Float32Array(16384);
        this.audioLength = 0;
        this.#connect();
        for (const gba of [...this.machines].reverse()) gba.sio.plugged();
    }

    #connect() {
        const [a, b] = this.machines;
        // Where each machine's clock is at the end of the current slice.
        this.time = a.bus.cycles;
        a.partner = b;
        b.partner = a;
        a.sio.link = b.sio;
        b.sio.link = a.sio;
        a.sio.player = 0;
        b.sio.player = 1;
        a.sio.offset = b.bus.cycles - a.bus.cycles;
        b.sio.offset = -a.sio.offset;
    }

    /** Disconnects; the machines keep running on their own. */
    unlink() {
        for (const gba of this.machines) {
            gba.partner = null;
            gba.sio.link = null;
            gba.sio.player = 0;
        }
    }

    reset() {
        for (const gba of this.machines) gba.reset();
        this.#connect();
    }

    configure(options) {
        for (const gba of this.machines) gba.configure(options);
    }

    setInput(buttons) {
        this.machines[0].setInput(buttons & 0xffff);
        this.machines[1].setInput(buttons >>> PLAYER_2_SHIFT);
    }

    runFrame() {
        const [a, b] = this.machines;
        const offset = a.sio.offset;
        a.beginFrame();
        b.beginFrame();
        // Absolute targets, so instructions running past a slice's end don't add up.
        const end = this.time + FRAME_CYCLES;
        while (this.time < end) {
            this.time = Math.min(this.time + SLICE_CYCLES, end);
            a.runUntil(this.time);
            b.runUntil(this.time + offset);
        }
        a.endFrame();
        b.endFrame();
        this.#compose();
        this.#mix();
    }

    #compose() {
        const { pixels, vertical, width } = this;
        this.machines.forEach((gba, player) => {
            const source = new Uint32Array(gba.getFrameBuffer().buffer);
            for (let y = 0; y < SCREEN_HEIGHT; y++) {
                const row = source.subarray(y * SCREEN_WIDTH, (y + 1) * SCREEN_WIDTH);
                const offset = vertical ? (player * SCREEN_HEIGHT + y) * width : y * width + player * SCREEN_WIDTH;
                pixels.set(row, offset);
            }
        });
    }

    #mix() {
        const first = this.machines[0].getAudioSamples();
        const second = this.machines[1].getAudioSamples();
        const length = Math.min(first.length, second.length, this.audio.length);
        for (let i = 0; i < length; i++) this.audio[i] = (first[i] + second[i]) * 0.5;
        this.audioLength = length;
    }

    getFrameBuffer() {
        return this.frame;
    }

    getAudioSamples() {
        return this.audio.subarray(0, this.audioLength);
    }

    getSaveData(player = 0) {
        return this.machines[player].getSaveData();
    }

    loadSaveData(data, player = 0) {
        this.machines[player].loadSaveData(data);
    }

    getSaveWrites(player = 0) {
        return this.machines[player].getSaveWrites();
    }

    getMemoryRegions() {
        return this.machines.flatMap((gba, player) => renamed(gba.getMemoryRegions(), `Player ${player + 1}: `));
    }

    screenshot(player = 0) {
        return { pixels: this.machines[player].getFrameBuffer().slice(), width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
    }

    getRumble() {
        return Math.max(this.machines[0].getRumble(), this.machines[1].getRumble());
    }

    saveState() {
        const s = new StateWriter();
        s.u32(STATE_MAGIC);
        s.f64(this.time);
        for (const gba of this.machines) {
            const state = gba.saveState();
            s.u32(state.length);
            s.bytes(state);
        }
        return s.finish();
    }

    loadState(data) {
        const s = new StateReader(data);
        if (s.u32() !== STATE_MAGIC) throw new Error("This snapshot is not of linked games.");
        const time = s.f64();
        const states = this.machines.map(() => {
            const state = new Uint8Array(s.u32());
            s.bytes(state);
            return state;
        });
        this.machines.forEach((gba, i) => gba.loadState(states[i]));
        this.#connect();
        this.time = time;
    }
}
