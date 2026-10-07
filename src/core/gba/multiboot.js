import { bootState } from "./bios.js";

// Multiboot: a GBA without a cartridge waits in its BIOS for a program sent
// over the link cable by the parent's game (single-cartridge multiplayer).
// Protocol from GBATEK as implemented by gba-link-connection's
// LinkCableMultiboot (MIT); multiplayer mode only.

const HEADER_SIZE = 0xc0;
// Player 2 is the first client.
const CLIENT_BIT = 2;
const SEED_MULTIPLIER = 0x6f646573;
const DATA_XOR = 0x6465646f;
const CRC_START = 0xfff8;
const CRC_XOR = 0xa517;
// The byte the client answers the handshake with (any value works).
const CLIENT_DATA = 0x5a;
const CLIENT_REPLY = 0x00;

const State = { DETECT: 0, HEADER: 1, AFTER_HEADER: 2, PALETTE: 3, READY: 4, DATA: 5, END: 6, CRC: 7, BOOTING: 8 };

/**
 * The BIOS's receiving side for the built-in BIOS: while it waits, the
 * machine runs no code (`Gba.stall`) and its serial port, in multiplayer
 * mode as a child, answers each transfer from the parent:
 * - 0x6200 -> 0x7202 (client 1 here), 0x610Y -> header coming;
 * - the 0xC0-byte header, 16 bits at a time, answered with what's left;
 * - 0x6200, 0x620Y (optional), then 0x63PP (palette) -> 0x73CC (CC: this
 *     client's byte), 0x64HH (HH: the parent's handshake byte);
 * - then either the parent's BIOS call MultiBoot (SWI 0x25, see
 *     `multiBoot`) hands the program over, or the game sends it itself: the
 *     length, each encrypted word in two halves (answered with its offset),
 *     0x65 -> 0x75, 0x66 -> the CRC, then the parent's CRC.
 * The program then starts at 0x020000C0, as after the real BIOS.
 */
export class MultibootClient {
    /** @param {import("./gba.js").Gba} gba A machine without a cartridge. */
    constructor(gba) {
        this.gba = gba;
        gba.sio.onMulti = (word) => this.#receive(word);
        this.state = State.DETECT;
    }

    /** At power-on: waits in multiplayer mode, screen blank. */
    reset() {
        const { gba } = this;
        this.state = State.DETECT;
        this.remaining = 0;
        this.palette = 0;
        this.handshake = 0;
        this.size = 0;
        this.index = 0;
        this.low = 0;
        this.half = false;
        this.seed = 0;
        this.crc = 0;
        gba.stall(Infinity);
        gba.write16(0, 0x80); // DISPCNT: forced blank
        gba.write16(0x134, 0); // RCNT: SIO
        gba.write16(0x128, 0x2003); // SIOCNT: multiplayer, 115200 bps
        this.#send(0);
    }

    /** The handshake is done: the program can come (SWI 0x25 or sent word by word). */
    get ready() {
        return this.state === State.READY;
    }

    #send(word) {
        this.gba.sio.data8 = word & 0xffff;
    }

    /** A multiplayer transfer ended; `word` is the parent's. */
    #receive(word) {
        switch (this.state) {
            case State.DETECT:
                if (word === 0x6200) this.#send(0x7200 | CLIENT_BIT);
                else if ((word & 0xff00) === 0x6100 && word & CLIENT_BIT) {
                    this.state = State.HEADER;
                    this.remaining = HEADER_SIZE / 2;
                    this.#send((this.remaining << 8) | CLIENT_BIT);
                }
                break;
            case State.HEADER: {
                const offset = HEADER_SIZE - this.remaining * 2;
                this.gba.bus.ewram[offset] = word & 0xff;
                this.gba.bus.ewram[offset + 1] = word >>> 8;
                this.remaining--;
                this.#send((this.remaining << 8) | CLIENT_BIT);
                if (!this.remaining) this.state = State.AFTER_HEADER;
                break;
            }
            case State.AFTER_HEADER:
                if (word === 0x6200) this.#send(0x7200 | CLIENT_BIT);
                else if ((word & 0xff00) === 0x6200) this.state = State.PALETTE;
                // Some senders skip the 0x6200, 0x620Y and go on to the palette.
                if ((word & 0xff00) !== 0x6300) break;
                this.state = State.PALETTE;
            // falls through
            case State.PALETTE:
            case State.READY:
                if ((word & 0xff00) === 0x6300) {
                    this.palette = word & 0xff;
                    this.#send(0x7300 | CLIENT_DATA);
                } else if ((word & 0xff00) === 0x6400) {
                    this.handshake = word & 0xff;
                    this.state = State.READY;
                    this.#send(0x7700 | CLIENT_REPLY);
                } else if (this.state === State.READY) {
                    this.#start(word);
                }
                break;
            case State.DATA:
                this.#data(word);
                break;
            case State.END:
                if (word === 0x65) this.#send(0x75);
                else if (word === 0x66) {
                    // The CRC ends with the handshake bytes (absent clients count as 0xFF).
                    this.crc = crcStep(this.crc & 0xffff, this.handshake | (CLIENT_REPLY << 8) | 0xffff0000) & 0xffff;
                    this.state = State.CRC;
                    this.#send(this.crc);
                }
                break;
            case State.CRC:
                if (word === this.crc) {
                    this.state = State.BOOTING;
                    this.gba.stall(this.gba.bus.cycles, () => this.#boot());
                } else {
                    this.reset();
                }
                break;
        }
    }

    /** The game sends the program itself: first its length. */
    #start(length) {
        this.size = length * 4 + 0x190;
        this.seed = (this.palette | (CLIENT_DATA << 8) | 0xffff0000) >>> 0;
        this.crc = CRC_START;
        this.index = HEADER_SIZE / 4;
        this.half = false;
        this.state = State.DATA;
        this.#send(this.index << 2);
    }

    /** Each word comes in two halves, encrypted with a running seed. */
    #data(word) {
        if (!this.half) {
            this.low = word;
            this.half = true;
            this.#send((this.index << 2) + 2);
            return;
        }
        this.seed = (Math.imul(this.seed, SEED_MULTIPLIER) + 1) >>> 0;
        const key = (0xfe000000 - (this.index << 2)) ^ this.seed ^ DATA_XOR;
        const plain = ((this.low | (word << 16)) ^ key) >>> 0;
        this.gba.bus.ewram32[this.index & 0xffff] = plain | 0;
        this.crc = crcStep(this.crc, plain);
        this.index++;
        this.half = false;
        if (this.index * 4 >= this.size) this.state = State.END;
        this.#send(this.index << 2);
    }

    /** The parent's MultiBoot call hands over the program (after the header); it starts at `time`. */
    deliver(program, time) {
        this.gba.bus.ewram.set(program.subarray(0, 0x40000 - HEADER_SIZE), HEADER_SIZE);
        this.state = State.BOOTING;
        this.gba.stall(time, () => this.#boot());
    }

    /** As the BIOS starts a multiboot program: boot mode and client number in the header. */
    #boot() {
        const { gba } = this;
        gba.bus.ewram[0xc4] = 3; // multiplayer boot
        gba.bus.ewram[0xc5] = 1; // client 1
        gba.write16(0, 0);
        bootState(gba.cpu);
        gba.cpu.branch(0x020000c0);
        gba.postflg = 1;
    }
}

function crcStep(crc, data) {
    for (let i = 0; i < 32; i++) {
        const bit = (crc ^ data) & 1;
        data >>>= 1;
        crc >>>= 1;
        if (bit) crc ^= CRC_XOR;
    }
    return crc;
}

/**
 * SWI 0x25 MultiBoot on the built-in BIOS: sends the program at
 * param.boot_srcp-boot_endp to a linked GBA without a cartridge that has
 * gone through the handshake, by copying it over. The parent's BIOS is busy
 * for as long as the transfer would take, then the client starts.
 *
 * @param {import("./gba.js").Gba} gba
 * @param {number} param  Address of the MultiBootParam structure.
 * @param {number} mode  0: Normal 256 KHz, 1: multiplayer, 2: Normal 2 MHz.
 * @returns {boolean} Success.
 */
export function multiBoot(gba, param, mode) {
    const client = gba.partner?.multibootClient;
    if (!client?.ready) return false;
    const { bus } = gba;
    const start = bus.dmaRead32(param + 0x20) >>> 0;
    const end = bus.dmaRead32(param + 0x24) >>> 0;
    const length = end - start;
    if (length < 0x100 || length > 0x40000 - HEADER_SIZE || length % 16) return false;
    const program = new Uint8Array(length);
    const view = new DataView(program.buffer);
    for (let i = 0; i < length; i += 4) view.setInt32(i, bus.dmaRead32(start + i), true);
    // Two 16-bit transfers per word in multiplayer mode, one 32-bit one otherwise.
    const perWord = mode === 1 ? 2 * gba.sio.multiCycles() : mode === 2 ? 32 * 8 + 64 : 32 * 64 + 64;
    const done = bus.cycles + (length / 4) * perWord;
    gba.stall(done);
    client.deliver(program, done + gba.sio.offset);
    return true;
}
