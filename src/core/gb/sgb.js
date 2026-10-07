import { SCREEN_HEIGHT, SCREEN_WIDTH } from './constants.js';
import { cgbToPixel, SGB_PALETTES } from './palettes.js';

// Command handling follows SameBoy's (MIT, Lior Halphon) sgb.c.

export const BORDER_WIDTH = 256;
export const BORDER_HEIGHT = 224;
// Where the Game Boy screen sits in the border.
const SCREEN_X = 48;
const SCREEN_Y = 40;
const PACKET_BITS = 128;
// Frames between a *_TRN command and the SNES reading the screen.
const TRANSFER_FRAMES = 3;

const Command = {
    PAL01: 0x00, PAL23: 0x01, PAL03: 0x02, PAL12: 0x03,
    ATTR_BLK: 0x04, ATTR_LIN: 0x05, ATTR_DIV: 0x06, ATTR_CHR: 0x07,
    PAL_SET: 0x0a, PAL_TRN: 0x0b, MLT_REQ: 0x11, CHR_TRN: 0x13, PCT_TRN: 0x14,
    ATTR_TRN: 0x15, ATTR_SET: 0x16, MASK_EN: 0x17,
};
const Transfer = { NONE: 0, LOW_TILES: 1, HIGH_TILES: 2, BORDER: 3, PALETTES: 4, ATTRIBUTES: 5 };
const Mask = { NONE: 0, FREEZE: 1, BLACK: 2, COLOR_0: 3 };

/** Whether a DMG game asks for Super Game Boy features (header $146 and old licensee $33). */
export function supportsSgb(rom) {
    return rom.length > 0x14b && rom[0x146] === 0x03 && rom[0x14b] === 0x33;
}

/**
 * Super Game Boy: what the SNES side does with a Game Boy game. Games send
 * commands as bits on P1 (palettes, which palette each 8x8 block uses,
 * screen masking, multiplayer) and bulk data by showing it on the screen
 * (border graphics, palette and attribute tables). The PPU outputs shades
 * 0-3; render() colors them and puts them in the border.
 */
export class Sgb {
    constructor() {
        this.packet = new Uint8Array(16 * 7);
        // 4 palettes of 4 colors (15-bit); color 0 is shared by all.
        this.palettes = new Uint16Array(16);
        // Sent with PAL_TRN: 512 palettes PAL_SET picks from.
        this.systemPalettes = new Uint16Array(512 * 4);
        // Sent with ATTR_TRN: 45 attribute files of 20x18 2-bit palette numbers.
        this.attributeFiles = new Uint8Array(45 * 90);
        // Palette per 8x8 block of the screen.
        this.attributes = new Uint8Array(20 * 18);
        this.borderTiles = new Uint8Array(256 * 32);
        this.borderMap = new Uint16Array(32 * 32);
        this.borderPalettes = new Uint16Array(64);
        // Shades of the screen being shown (kept while the mask freezes it).
        this.shades = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
        this.transferData = new Uint8Array(4096);

        this.colors = new Uint32Array(16);
        // The border drawn once per change; 0 marks transparent pixels.
        this.borderLayer = new Uint32Array(BORDER_WIDTH * BORDER_HEIGHT);
        this.screen = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
        this.screenBytes = new Uint8ClampedArray(this.screen.buffer);
        this.frame = new Uint32Array(BORDER_WIDTH * BORDER_HEIGHT);
        this.frameBytes = new Uint8ClampedArray(this.frame.buffer);
        this.showBorder = true;
        this.reset();
    }

    reset() {
        this.packet.fill(0);
        this.bitIndex = 0;
        this.readyForPulse = false;
        this.readyForWrite = false;
        this.readyForStop = false;
        this.palettes.fill(0);
        this.palettes.set(SGB_PALETTES['1-A']);
        this.systemPalettes.fill(0);
        this.attributeFiles.fill(0);
        this.attributes.fill(0);
        this.borderTiles.fill(0);
        this.borderMap.fill(0);
        this.borderPalettes.fill(0);
        this.shades.fill(0);
        this.mask = Mask.NONE;
        this.players = 1;
        this.player = 0;
        this.transfer = Transfer.NONE;
        this.transferFrames = 0;
        this.colorsDirty = true;
        this.borderDirty = true;
    }

    sync(s) {
        s.bytes(this.packet);
        this.bitIndex = s.u16(this.bitIndex);
        for (const flag of ['readyForPulse', 'readyForWrite', 'readyForStop']) this[flag] = s.bool(this[flag]);
        for (const array of ['palettes', 'systemPalettes', 'attributeFiles', 'attributes', 'borderTiles', 'borderMap',
            'borderPalettes', 'shades']) {
            s.bytes(this[array]);
        }
        for (const field of ['mask', 'players', 'player', 'transfer', 'transferFrames']) this[field] = s.u8(this[field]);
        this.colorsDirty = true;
        this.borderDirty = true;
    }

    get width() {
        return this.showBorder ? BORDER_WIDTH : SCREEN_WIDTH;
    }

    get height() {
        return this.showBorder ? BORDER_HEIGHT : SCREEN_HEIGHT;
    }

    /** The joypad ID P1 reads with no button group selected (multiplayer). */
    get joypadId() {
        return 0x0f - this.player;
    }

    /**
     * A write to P1: bits 4-5 low together start a packet, P14 low sends a
     * 0, P15 low a 1, both high between pulses. P15 rising selects the next
     * player in multiplayer mode.
     */
    writeP1(value, previous) {
        if (value & 0x20 && !(previous & 0x20) && (this.players & 1) === 0) {
            this.player = (this.player + 1) & (this.players - 1);
        }
        const length = (this.packet[0] & 7 || 1) * PACKET_BITS;
        switch (value & 0x30) {
            case 0x30:
                this.readyForPulse = true;
                break;
            case 0x00: // reset pulse
                if (!this.readyForPulse) return;
                this.readyForWrite = true;
                this.readyForPulse = false;
                if (this.bitIndex % PACKET_BITS !== 0 || this.bitIndex === 0 || this.readyForStop) {
                    this.bitIndex = 0;
                    this.packet.fill(0);
                    this.readyForStop = false;
                }
                break;
            case 0x20: // 0
                if (!this.readyForPulse || !this.readyForWrite) return;
                this.readyForPulse = false;
                if (this.readyForStop) {
                    if (this.bitIndex === length) {
                        this.#command();
                        this.bitIndex = 0;
                        this.packet.fill(0);
                    }
                    this.readyForWrite = false;
                    this.readyForStop = false;
                } else {
                    this.#bit(0);
                }
                break;
            case 0x10: // 1
                if (!this.readyForPulse || !this.readyForWrite) return;
                this.readyForPulse = false;
                if (this.readyForStop) {
                    // A 1 where the stop bit belongs: corrupt, start over.
                    this.readyForWrite = false;
                    this.bitIndex = 0;
                    this.packet.fill(0);
                } else {
                    this.#bit(1);
                }
                break;
        }
    }

    #bit(bit) {
        if (this.bitIndex >= this.packet.length * 8) return;
        if (bit) this.packet[this.bitIndex >> 3] |= 1 << (this.bitIndex & 7);
        this.bitIndex++;
        if (this.bitIndex % PACKET_BITS === 0) this.readyForStop = true;
    }

    #command() {
        const p = this.packet;
        if ((p[0] & 7) === 0) return;
        const word = (i) => p[i] | (p[i + 1] << 8);
        switch (p[0] >> 3) {
            case Command.PAL01: this.#setPalettes(0, 1); break;
            case Command.PAL23: this.#setPalettes(2, 3); break;
            case Command.PAL03: this.#setPalettes(0, 3); break;
            case Command.PAL12: this.#setPalettes(1, 2); break;
            case Command.ATTR_BLK: this.#attrBlock(); break;
            case Command.ATTR_LIN: this.#attrLines(); break;
            case Command.ATTR_DIV: this.#attrDivide(); break;
            case Command.ATTR_CHR: this.#attrChars(); break;
            case Command.PAL_SET: {
                for (let i = 0; i < 4; i++) {
                    const index = (word(1 + i * 2) & 0x1ff) * 4;
                    this.palettes.set(this.systemPalettes.subarray(index, index + 4), i * 4);
                }
                this.#shareColor0(this.palettes[0]);
                if (p[9] & 0x80) this.#loadAttributeFile(p[9] & 0x3f);
                if (p[9] & 0x40) this.mask = Mask.NONE;
                this.colorsDirty = true;
                break;
            }
            case Command.PAL_TRN: this.#startTransfer(Transfer.PALETTES); break;
            case Command.MLT_REQ:
                this.players = [1, 2, 4, 4][p[1] & 3];
                this.player &= this.players - 1;
                break;
            case Command.CHR_TRN: this.#startTransfer(p[1] & 1 ? Transfer.HIGH_TILES : Transfer.LOW_TILES); break;
            case Command.PCT_TRN: this.#startTransfer(Transfer.BORDER); break;
            case Command.ATTR_TRN: this.#startTransfer(Transfer.ATTRIBUTES); break;
            case Command.ATTR_SET:
                this.#loadAttributeFile(p[1] & 0x3f);
                if (p[1] & 0x40) this.mask = Mask.NONE;
                break;
            case Command.MASK_EN:
                this.mask = p[1] & 3;
                break;
            // Sound, SNES code uploads (DATA_SND/TRN, JUMP) and the rest aren't emulated.
        }
    }

    #setPalettes(first, second) {
        const p = this.packet;
        const color = (i) => p[i] | (p[i + 1] << 8);
        this.#shareColor0(color(1));
        for (let i = 0; i < 3; i++) {
            this.palettes[first * 4 + 1 + i] = color(3 + i * 2);
            this.palettes[second * 4 + 1 + i] = color(9 + i * 2);
        }
        this.colorsDirty = true;
    }

    #shareColor0(color) {
        for (let i = 0; i < 16; i += 4) this.palettes[i] = color;
        this.borderDirty = true;
    }

    #attrBlock() {
        const p = this.packet;
        const count = p[1];
        if (count > 0x12) return;
        for (let i = 0; i < count; i++) {
            const at = 2 + i * 6;
            const control = p[at];
            const inside = (control & 1) !== 0;
            let line = (control & 2) !== 0;
            const outside = (control & 4) !== 0;
            const insidePalette = p[at + 1] & 3;
            let linePalette = (p[at + 1] >> 2) & 3;
            const outsidePalette = (p[at + 1] >> 4) & 3;
            // Only inside or only outside: the frame line takes that palette too.
            if (inside && !line && !outside) [line, linePalette] = [true, insidePalette];
            else if (outside && !line && !inside) [line, linePalette] = [true, outsidePalette];
            const [left, top, right, bottom] = [p[at + 2] & 0x1f, p[at + 3] & 0x1f, p[at + 4] & 0x1f, p[at + 5] & 0x1f];
            for (let y = 0; y < 18; y++) {
                for (let x = 0; x < 20; x++) {
                    if (x < left || x > right || y < top || y > bottom) {
                        if (outside) this.attributes[y * 20 + x] = outsidePalette;
                    } else if (x > left && x < right && y > top && y < bottom) {
                        if (inside) this.attributes[y * 20 + x] = insidePalette;
                    } else if (line) {
                        this.attributes[y * 20 + x] = linePalette;
                    }
                }
            }
        }
    }

    #attrLines() {
        const p = this.packet;
        const count = p[1];
        if (count > p.length - 2) return;
        for (let i = 0; i < count; i++) {
            const data = p[2 + i];
            const palette = (data >> 5) & 3;
            const line = data & 0x1f;
            if (data & 0x80) {
                if (line < 18) this.attributes.fill(palette, line * 20, line * 20 + 20);
            } else if (line < 20) {
                for (let y = 0; y < 18; y++) this.attributes[y * 20 + line] = palette;
            }
        }
    }

    #attrDivide() {
        const p = this.packet;
        const high = p[1] & 3;
        const low = (p[1] >> 2) & 3;
        const middle = (p[1] >> 4) & 3;
        const horizontal = (p[1] & 0x40) !== 0;
        const line = p[2] & 0x1f;
        for (let y = 0; y < 18; y++) {
            for (let x = 0; x < 20; x++) {
                const at = horizontal ? y : x;
                this.attributes[y * 20 + x] = at < line ? low : at === line ? middle : high;
            }
        }
    }

    #attrChars() {
        const p = this.packet;
        let x = p[1];
        let y = p[2];
        const count = p[3] | (p[4] << 8);
        const vertical = p[5] !== 0;
        if (x >= 20 || y >= 18) return;
        for (let i = 0; i < count && 6 + (i >> 2) < p.length; i++) {
            this.attributes[y * 20 + x] = (p[6 + (i >> 2)] >> ((3 - (i & 3)) * 2)) & 3;
            if (vertical) {
                if (++y === 18) {
                    y = 0;
                    if (++x === 20) break;
                }
            } else if (++x === 20) {
                x = 0;
                if (++y === 18) break;
            }
        }
    }

    #loadAttributeFile(index) {
        if (index >= 45) return;
        for (let i = 0; i < 90; i++) {
            const byte = this.attributeFiles[index * 90 + i];
            for (let j = 0; j < 4; j++) this.attributes[i * 4 + j] = (byte >> (6 - j * 2)) & 3;
        }
    }

    #startTransfer(kind) {
        this.transfer = kind;
        this.transferFrames = TRANSFER_FRAMES;
    }

    /**
     * Reads 4 KB off the screen the way the SNES does: tiles of 8x8 pixels,
     * left to right and top to bottom, each row as two Game Boy bitplanes.
     */
    #readTransfer(shades) {
        const data = this.transferData;
        for (let tile = 0; tile < 256; tile++) {
            const left = (tile % 20) * 8;
            const top = ((tile / 20) | 0) * 8;
            for (let row = 0; row < 8; row++) {
                let low = 0;
                let high = 0;
                const base = (top + row) * SCREEN_WIDTH + left;
                for (let x = 0; x < 8; x++) {
                    const shade = shades[base + x];
                    low |= (shade & 1) << (7 - x);
                    high |= ((shade >> 1) & 1) << (7 - x);
                }
                data[tile * 16 + row * 2] = low;
                data[tile * 16 + row * 2 + 1] = high;
            }
        }
        const word = (i) => data[i] | (data[i + 1] << 8);
        switch (this.transfer) {
            case Transfer.LOW_TILES: this.borderTiles.set(data, 0); break;
            case Transfer.HIGH_TILES: this.borderTiles.set(data, 4096); break;
            case Transfer.BORDER:
                for (let i = 0; i < 1024; i++) this.borderMap[i] = word(i * 2);
                for (let i = 0; i < 64; i++) this.borderPalettes[i] = word(0x800 + i * 2);
                break;
            case Transfer.PALETTES:
                for (let i = 0; i < 2048; i++) this.systemPalettes[i] = word(i * 2);
                break;
            case Transfer.ATTRIBUTES:
                this.attributeFiles.set(data.subarray(0, this.attributeFiles.length));
                break;
        }
        if (this.transfer !== Transfer.PALETTES && this.transfer !== Transfer.ATTRIBUTES) this.borderDirty = true;
        this.transfer = Transfer.NONE;
    }

    /**
     * Once per frame: finishes a pending transfer and composes the output
     * from the PPU's shades (one per pixel, 0-3).
     * @param {Uint32Array} shades
     */
    render(shades) {
        if (this.transferFrames && --this.transferFrames === 0) this.#readTransfer(shades);
        if (this.mask !== Mask.FREEZE) {
            for (let i = 0; i < this.shades.length; i++) this.shades[i] = shades[i];
        }
        if (this.colorsDirty) {
            for (let i = 0; i < 16; i++) this.colors[i] = cgbToPixel(this.palettes[i], false);
            this.colorsDirty = false;
        }
        this.#renderScreen();
        if (!this.showBorder) return;
        if (this.borderDirty) this.#renderBorder();
        const { frame, borderLayer, screen } = this;
        const backdrop = this.colors[0];
        for (let y = 0; y < BORDER_HEIGHT; y++) {
            const inRows = y >= SCREEN_Y && y < SCREEN_Y + SCREEN_HEIGHT;
            for (let x = 0; x < BORDER_WIDTH; x++) {
                const i = y * BORDER_WIDTH + x;
                const border = borderLayer[i];
                if (border) frame[i] = border;
                else if (inRows && x >= SCREEN_X && x < SCREEN_X + SCREEN_WIDTH) {
                    frame[i] = screen[(y - SCREEN_Y) * SCREEN_WIDTH + x - SCREEN_X];
                } else frame[i] = backdrop;
            }
        }
    }

    #renderScreen() {
        const { screen, shades, colors, attributes } = this;
        if (this.mask === Mask.BLACK || this.mask === Mask.COLOR_0) {
            screen.fill(this.mask === Mask.BLACK ? cgbToPixel(0, false) : colors[0]);
            return;
        }
        for (let y = 0; y < SCREEN_HEIGHT; y++) {
            const row = ((y >> 3) * 20) | 0;
            for (let x = 0; x < SCREEN_WIDTH; x++) {
                const i = y * SCREEN_WIDTH + x;
                screen[i] = colors[(attributes[row + (x >> 3)] << 2) | shades[i]];
            }
        }
    }

    /** SNES tiles (4 bits per pixel) on a 32x28 map; color 0 is see-through. */
    #renderBorder() {
        this.borderDirty = false;
        const layer = this.borderLayer;
        const tiles = this.borderTiles;
        const colors = new Uint32Array(64);
        for (let i = 0; i < 64; i++) colors[i] = cgbToPixel(this.borderPalettes[i], false);
        for (let ty = 0; ty < 28; ty++) {
            for (let tx = 0; tx < 32; tx++) {
                const entry = this.borderMap[ty * 32 + tx];
                const tile = entry & 0x3ff;
                const palette = ((entry >> 10) & 3) * 16;
                const flipX = entry & 0x4000 ? 0 : 7;
                const flipY = entry & 0x8000 ? 7 : 0;
                for (let y = 0; y < 8; y++) {
                    const base = (tile & 0xff) * 32 + (y ^ flipY) * 2;
                    for (let x = 0; x < 8; x++) {
                        const bit = 1 << (x ^ flipX);
                        const color = tile > 0xff ? 0
                            : ((tiles[base] & bit) ? 1 : 0) | ((tiles[base + 1] & bit) ? 2 : 0) |
                                ((tiles[base + 16] & bit) ? 4 : 0) | ((tiles[base + 17] & bit) ? 8 : 0);
                        layer[(ty * 8 + y) * BORDER_WIDTH + tx * 8 + x] = color ? colors[palette + color] : 0;
                    }
                }
            }
        }
    }
}
