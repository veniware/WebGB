/*
 * The display state machine, pixel fetcher and FIFOs, line renderer and OAM
 * bug patterns are ported from SameBoy's Core/display.c and Core/memory.c
 * (reduced to the DMG-B, SGB and CGB-E; the output is WebGB's own).
 * SameBoy's license:
 *
 * Copyright (c) 2015-2026 Lior Halphon
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "./constants.js";
import { cgbToPixel, DEFAULT_DMG_PALETTE, rgbToPixel } from "./palettes.js";

const LINE_LENGTH = 456;
const LINES = 144;
const MODE2_LENGTH = 80;
const FRAME_LENGTH = 70224;
const WHITE = 0xffffffff;
const BLACK = 0xff000000;

// I/O register offsets (from FF00).
const IF = 0x0f;
const LCDC = 0x40;
const STAT = 0x41;
const SCY = 0x42;
const SCX = 0x43;
const LY = 0x44;
const LYC = 0x45;
const BGP = 0x47;
const OBP0 = 0x48;
const OBP1 = 0x49;
const WY = 0x4a;
const WX = 0x4b;
const BCPS = 0x68;
const OCPS = 0x6a;
const OPRI = 0x6c;

// Background fetcher steps; VRAM reads take 2 dots (address, then data).
const Fetch = { TILE_1: 0, TILE_2: 1, LOW_1: 2, LOW_2: 3, HIGH_1: 4, HIGH_2: 5, PUSH: 6 };

// Sprite order: by X (DMG), or by OAM index (CGB).
const Priority = { X: 0, INDEX: 1 };

// "None" in 8- and 16-bit fields.
const NONE_8 = 0xff;
const NONE_16 = 0xffff;

// Where the state machine continues; numbers below 100 are SameBoy's sleep
// states (so traces compare directly), the others jump targets.
const S = {
    LCD_OFF: 100, LINES: 101, LINE: 102, OAM_SCAN: 103, OAM_ENTRY: 104, OAM_DONE: 105, MODE3: 106,
    PIXEL: 107, OBJECTS: 108, OBJECT: 109, OBJECT_WAIT: 110, OBJECT_FETCH: 111, PIXEL_OUT: 112,
    HBLANK: 113, VBLANK_LINES: 114, LINE_153: 115,
};

/** OAM bug corruption patterns (DMG-B, from SameBoy). */
function glitch(a, b, c) {
    return ((a ^ c) & (b ^ c)) ^ c;
}

function glitchRead(a, b, c) {
    return b | (a & c);
}

function glitchReadSecondary(a, b, c, d) {
    return (b & (a | c | d)) | (a & c & d);
}

function glitchTertiary1(a, b, c, d, e) {
    return c | (a & b & d & e);
}

function glitchTertiary2(a, b, c, d, e) {
    return (c & (a | b | d | e)) | (a & b & d & e);
}

function glitchTertiary3(a, b, c, d, e) {
    return (c & (a | b | d | e)) | (b & d & e);
}

function glitchQuaternary(a, b, c, d, e, f, g, h) {
    return (e & (h | g | (~d & f) | c | b)) | (c & g & h);
}

function flip(x) {
    x = ((x & 0xf0) >> 4) | ((x & 0x0f) << 4);
    x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
    return ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
}

/** An 8-pixel FIFO (background or sprites). */
class Fifo {
    constructor() {
        this.pixel = new Uint8Array(8);
        this.palette = new Uint8Array(8);
        this.priority = new Uint8Array(8);
        this.bgPriority = new Uint8Array(8);
        this.readEnd = 0;
        this.size = 0;
    }

    sync(s) {
        s.bytes(this.pixel);
        s.bytes(this.palette);
        s.bytes(this.priority);
        s.bytes(this.bgPriority);
        this.readEnd = s.u8(this.readEnd);
        this.size = s.u8(this.size);
    }

    clear() {
        this.readEnd = 0;
        this.size = 0;
    }

    /** Removes the next pixel; returns its index in the arrays. */
    pop() {
        const i = this.readEnd;
        this.readEnd = (i + 1) & 7;
        this.size--;
        return i;
    }

    pushBgRow(lower, upper, palette, bgPriority, flipX) {
        this.size = 8;
        for (let i = 0; i < 8; i++) {
            const bit = flipX ? i : 7 - i;
            this.pixel[i] = ((lower >> bit) & 1) | (((upper >> bit) & 1) << 1);
            this.palette[i] = palette;
            this.priority[i] = 0;
            this.bgPriority[i] = bgPriority;
        }
    }

    overlayObjectRow(lower, upper, palette, bgPriority, priority, flipX) {
        while (this.size < 8) {
            const i = (this.readEnd + this.size) & 7;
            this.pixel[i] = 0;
            this.palette[i] = 0;
            this.priority[i] = 0;
            this.bgPriority[i] = 0;
            this.size++;
        }
        const flipXor = flipX ? 0 : 7;
        for (let i = 7; i >= 0; i--) {
            const pixel = ((lower >> 7) & 1) | (((upper >> 7) & 1) << 1);
            const target = (this.readEnd + (i ^ flipXor)) & 7;
            if (pixel !== 0 && (this.pixel[target] === 0 || this.priority[target] > priority)) {
                this.pixel[target] = pixel;
                this.palette[target] = palette;
                this.bgPriority[target] = bgPriority;
                this.priority[target] = priority;
            }
            lower <<= 1;
            upper <<= 1;
        }
    }
}

/**
 * Picture processing unit, DMG and CGB, timed to the dot: a port of
 * SameBoy's display state machine (display.c, MIT, Lior Halphon).
 *
 * The state machine runs in 8 MHz units (2 per dot) and stops at "sleeps",
 * resuming when the CPU has advanced past them. Mode 3 pushes pixels
 * through a background fetcher and FIFOs one dot at a time, so mid-line
 * register writes show; a line nobody can observe being drawn (no sprites,
 * window or STAT HBlank interrupt changing its length, and no CPU access to
 * the PPU meanwhile) is drawn in one go instead (`#renderLine`).
 *
 * Frames are drawn into a back buffer and swapped in at VBlank, so the front
 * buffer always holds a complete frame.
 */
export class Ppu {
    #oamWords;

    /** @param {import("./gameboy.js").GameBoy} gb */
    constructor(gb) {
        this.gb = gb;
        this.cpu = gb.cpu;
        this.cgb = gb.cgb;
        this.vram = new Uint8Array(this.cgb ? 0x4000 : 0x2000);
        this.oam = new Uint8Array(0xa0);
        // OAM as 16-bit words (little-endian hosts), for the OAM bug.
        this.#oamWords = new Uint16Array(this.oam.buffer);
        this.bgPaletteRam = new Uint8Array(64);
        this.objPaletteRam = new Uint8Array(64);
        // Colors by palette * 4 + color index (DMG: shades through BGP/OBP0/OBP1).
        this.bgRgb = new Uint32Array(32);
        this.objRgb = new Uint32Array(32);
        // DMG mode: the colors BGP, OBP0 and OBP1 pick from (one set on a DMG,
        // three when a Game Boy Color colors an old game).
        this.dmgBg = new Uint32Array(DEFAULT_DMG_PALETTE.map(rgbToPixel));
        this.dmgObj0 = this.dmgBg.slice();
        this.dmgObj1 = this.dmgBg.slice();
        // CGB colors mixed to look like the Game Boy Color's LCD.
        this.colorCorrection = false;

        this.front = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
        this.back = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
        this.frontBytes = new Uint8ClampedArray(this.front.buffer);
        this.backBytes = new Uint8ClampedArray(this.back.buffer);

        this.bgFifo = new Fifo();
        this.oamFifo = new Fifo();
        this.visibleObjs = new Uint8Array(10);
        this.objectsX = new Uint8Array(10);
        this.objectsY = new Uint8Array(10);
        this.currentTileData = new Uint8Array(2);
        this.objectTileData = new Uint8Array(2);
        // #renderLine's sprite pixels, by screen x + 8.
        this.lineObjPixel = new Uint8Array(176);
        this.lineObjPriority = new Uint8Array(176);
        this.lineObjPalette = new Uint8Array(176);
        this.lineObjBgPriority = new Uint8Array(176);
        // #tileData's results.
        this.tileAttributes = 0;
        this.tileLow = 0;
        this.tileHigh = 0;
        // Set for a T-cycle by some CPU writes (see cpu.js); not part of the state.
        this.wxJustChanged = false;
        this.tileSelGlitch = false;
        this.reset();
    }

    reset() {
        this.vram.fill(0);
        this.oam.fill(0);
        this.bgPaletteRam.fill(0xff);
        this.objPaletteRam.fill(0xff);
        this.vramBank = 0;
        this.objectPriority = this.cgb ? Priority.INDEX : Priority.X;

        // The state machine: where it stopped and the time it's owed (8 MHz units, <= 0 when caught up).
        this.state = 0;
        this.cycles = 0;
        // This run's input, for syncing OAM DMA with the fetcher (dma_sync).
        this.runCycles = 0;
        this.cyclesForLine = 0;
        this.cyclesSinceVblank = 0;
        this.mode3BatchingLength = 0;

        this.positionInLine = 0;
        this.statInterruptLine = false;
        this.windowY = 0;
        this.frameSkipped = false;
        this.oamReadBlocked = false;
        this.vramReadBlocked = false;
        this.oamWriteBlocked = false;
        this.vramWriteBlocked = false;
        this.currentLine = 0;
        this.lyForComparison = 0;
        this.bgFifo.clear();
        this.oamFifo.clear();
        this.fetcherY = 0;
        this.currentTile = 0;
        this.currentTileAttributes = 0;
        this.currentTileData.fill(0);
        this.fetcherState = 0;
        this.windowIsBeingFetched = false;
        this.wxTriggered = false;
        this.visibleObjs.fill(0);
        this.objectsX.fill(0);
        this.objectsY.fill(0);
        this.objectTileData.fill(0);
        this.mode2YBus = 0;
        // The X bus also carries a sprite's flags when it is fetched.
        this.mode2XBus = 0;
        this.nVisibleObjs = 0;
        this.origNVisibleObjs = 0;
        this.oamSearchIndex = 0;
        this.accessedOamRow = NONE_8;
        this.modeForInterrupt = 0;
        this.lycInterruptLine = false;
        this.cgbPalettesBlocked = false;
        this.oamPpuBlocked = false;
        this.vramPpuBlocked = false;
        this.cgbPalettesPpuBlocked = false;
        this.objectFetchAborted = false;
        this.duringObjectFetch = false;
        this.objectLowLineAddress = 0;
        this.wyTriggered = false;
        this.windowTileX = 0;
        this.lcdX = 0;
        this.lastTileDataAddress = 0;
        this.lastTileIndexAddress = 0;
        this.dataForSelGlitch = 0;
        this.delayedGlitchHblankInterrupt = false;
        this.disableWindowPixelInsertionGlitch = false;
        this.insertBgPixel = false;
        this.cpuVramBus = 0;
        this.lastTileset = false;
        this.cgbWxGlitch = false;
        this.lineHasFractionalScrolling = false;
        this.wyCheckModulo = 0;
        this.wyCheckScheduled = false;
        this.wyJustChecked = false;
        this.wx166InterruptGlitch = false;

        this.frameDone = false;
        this.#refreshColors();
        this.front.fill(this.#blank());
        this.back.fill(this.#blank());
    }

    sync(s) {
        s.bytes(this.vram);
        s.bytes(this.oam);
        s.bytes(this.bgPaletteRam);
        s.bytes(this.objPaletteRam);
        for (const r of ["vramBank", "objectPriority", "state", "positionInLine", "windowY", "currentLine", "fetcherY",
            "currentTile", "currentTileAttributes", "fetcherState", "mode2YBus", "mode2XBus", "nVisibleObjs",
            "origNVisibleObjs", "oamSearchIndex", "accessedOamRow", "modeForInterrupt", "windowTileX", "lcdX",
            "dataForSelGlitch", "cpuVramBus", "wyCheckModulo"]) {
            this[r] = s.u8(this[r]);
        }
        for (const r of ["cyclesForLine", "mode3BatchingLength", "lyForComparison", "objectLowLineAddress",
            "lastTileDataAddress", "lastTileIndexAddress"]) {
            this[r] = s.u16(this[r]);
        }
        this.cycles = s.i32(this.cycles);
        this.cyclesSinceVblank = s.u32(this.cyclesSinceVblank);
        for (const flag of ["statInterruptLine", "frameSkipped", "oamReadBlocked", "vramReadBlocked", "oamWriteBlocked",
            "vramWriteBlocked", "windowIsBeingFetched", "wxTriggered", "lycInterruptLine", "cgbPalettesBlocked",
            "oamPpuBlocked", "vramPpuBlocked", "cgbPalettesPpuBlocked", "objectFetchAborted", "duringObjectFetch",
            "wyTriggered", "delayedGlitchHblankInterrupt", "disableWindowPixelInsertionGlitch", "insertBgPixel",
            "lastTileset", "cgbWxGlitch", "lineHasFractionalScrolling", "wyCheckScheduled", "wyJustChecked",
            "wx166InterruptGlitch", "frameDone"]) {
            this[flag] = s.bool(this[flag]);
        }
        this.bgFifo.sync(s);
        this.oamFifo.sync(s);
        s.bytes(this.visibleObjs);
        s.bytes(this.objectsX);
        s.bytes(this.objectsY);
        s.bytes(this.currentTileData);
        s.bytes(this.objectTileData);
        // The back buffer is redrawn before it's shown (states are taken between frames).
        s.bytes(this.front);
        if (s.reading) {
            this.back.set(this.front);
            this.#refreshColors();
        }
    }

    // --- Colors ----------------------------------------------------------------------

    /** Super Game Boy: frames hold shades 0-3 instead of colors, for the SGB to color. */
    outputShades() {
        for (const colors of [this.dmgBg, this.dmgObj0, this.dmgObj1]) colors.set([0, 1, 2, 3]);
        this.#refreshColors();
        this.front.fill(0);
        this.back.fill(0);
    }

    /** Sets the four DMG shades, lightest first, as 0xRRGGBB. */
    setDmgPalette(colors) {
        const pixels = colors.map(rgbToPixel);
        this.dmgBg.set(pixels);
        this.dmgObj0.set(pixels);
        this.dmgObj1.set(pixels);
        this.#refreshColors();
    }

    /**
     * Colors a DMG game like a Game Boy Color: separate 15-bit palettes for BG
     * and sprites. `corrected`: mimic the GBC's LCD (not for SGB colors on a TV).
     */
    setCompatPalette({ bg, obj0, obj1 }, corrected = this.colorCorrection) {
        const pixel = (color) => cgbToPixel(color, corrected);
        this.dmgBg.set(bg.map(pixel));
        this.dmgObj0.set(obj0.map(pixel));
        this.dmgObj1.set(obj1.map(pixel));
        this.#refreshColors();
    }

    setColorCorrection(enabled) {
        this.colorCorrection = enabled;
        this.#refreshColors();
    }

    /** After the palette RAM was changed directly (memory editor). */
    refreshPalettes() {
        this.#refreshColors();
    }

    #refreshColors() {
        if (!this.cgb) {
            this.bgRgb.set(this.dmgBg);
            this.objRgb.set(this.dmgObj0);
            this.objRgb.set(this.dmgObj1, 4);
            return;
        }
        for (let i = 0; i < 32; i++) {
            this.bgRgb[i] = cgbToPixel(this.bgPaletteRam[i * 2] | (this.bgPaletteRam[i * 2 + 1] << 8), this.colorCorrection);
            this.objRgb[i] = cgbToPixel(this.objPaletteRam[i * 2] | (this.objPaletteRam[i * 2 + 1] << 8), this.colorCorrection);
        }
    }

    #blank() {
        return this.cgb ? WHITE : this.dmgBg[0];
    }

    get enabled() {
        return (this.gb.io[LCDC] & 0x80) !== 0;
    }

    // --- STAT -------------------------------------------------------------------------

    /** Updates the LY=LYC flag and raises the STAT interrupt on a rising edge of its sources (GB_STAT_update). */
    statUpdate() {
        const io = this.gb.io;
        if (!(io[LCDC] & 0x80)) return;
        // OAM DMA hides OAM scan's mode from STAT.
        if (this.gb.dmaCurrentDest !== 0xa1 && (io[STAT] & 3) === 2) io[STAT] &= ~3;
        const previous = this.statInterruptLine;
        if (this.lyForComparison !== NONE_16 || !this.cgb) {
            if (this.lyForComparison === io[LYC]) {
                this.lycInterruptLine = true;
                io[STAT] |= 4;
            } else {
                if (this.lyForComparison !== NONE_16) this.lycInterruptLine = false;
                io[STAT] &= ~4;
            }
        }
        let line;
        switch (this.modeForInterrupt) {
            case 0: line = (io[STAT] & 0x08) !== 0; break;
            case 1: line = (io[STAT] & 0x10) !== 0; break;
            case 2: line = (io[STAT] & 0x20) !== 0; break;
            default: line = false;
        }
        if (io[STAT] & 0x40 && this.lycInterruptLine) line = true;
        if (line && !previous) io[IF] |= 2;
        this.statInterruptLine = line;
    }

    /** The window can only start on a frame once LY has matched WY while it was enabled. */
    #wyCheck() {
        const io = this.gb.io;
        if (!(io[LCDC] & 0x80)) return;
        let comparison = this.currentLine;
        // (SameBoy compares with an 8-bit -1 here.)
        if ((!this.cgb || this.gb.doubleSpeed) && this.lyForComparison !== 0xff) comparison = this.lyForComparison & 0xff;
        if (io[LCDC] & 0x20 && io[WY] === comparison) this.wyTriggered = true;
    }

    updateWxGlitch() {
        if (!this.cgb) return;
        const io = this.gb.io;
        if (!(io[LCDC] & 0x20) || !this.wyTriggered) {
            this.cgbWxGlitch = false;
            return;
        }
        const position = this.positionInLine;
        if (io[WX] === 0) {
            this.cgbWxGlitch = ((position + 16) & 0xff) <= 8 || (position === 0xf9 && this.lineHasFractionalScrolling);
            return;
        }
        this.cgbWxGlitch = ((position + 7 + (this.windowIsBeingFetched ? 1 : 0)) & 0xff) === io[WX];
    }

    // --- Registers --------------------------------------------------------------------

    /** Writes a PPU register (FF40-FF4B, VBK, palettes, OPRI); the PPU is in sync. */
    writeRegister(reg, value) {
        const gb = this.gb;
        const io = gb.io;
        switch (reg) {
            case LCDC: this.#writeLcdc(value); return;
            case STAT:
                io[STAT] = (io[STAT] & 7) | (value & ~7) | 0x80;
                if (gb.doubleSpeed && this.state === 8 && this.oamSearchIndex === 0 && this.cycles === 0 && value & 0x20) {
                    this.modeForInterrupt = 2;
                    this.statUpdate();
                    this.modeForInterrupt = NONE_8;
                } else {
                    this.statUpdate();
                }
                return;
            case LYC:
                if (this.state === 29 && this.cgb) {
                    this.lyForComparison = 153;
                    this.statUpdate();
                    this.lyForComparison = 0;
                }
                io[LYC] = value;
                // Where LY changes, the state machine updates STAT itself.
                if (!this.cgb || (this.state !== 35 && this.state !== 26 && this.state !== 15 && this.state !== 16)) {
                    if (this.state === 14 && this.cgb) {
                        this.lyForComparison = 153;
                        this.statUpdate();
                        this.lyForComparison = NONE_16;
                    } else {
                        this.statUpdate();
                    }
                }
                return;
            case WY:
                io[WY] = value;
                this.wyCheckScheduled = true;
                return;
            case WX:
                io[WX] = value;
                this.updateWxGlitch();
                return;
            case SCY: case SCX: case BGP: case OBP0: case OBP1:
                io[reg] = value;
                return;
            case 0x4f: // VBK
                if (this.cgb) this.vramBank = value & 1;
                return;
            case BCPS: case OCPS:
                if (this.cgb) io[reg] = value;
                return;
            case 0x69: case 0x6b: { // BCPD, OCPD
                if (!this.cgb) return;
                const index = reg - 1;
                if (!this.cgbPalettesBlocked) {
                    const background = reg === 0x69;
                    const i = io[index] & 0x3f;
                    (background ? this.bgPaletteRam : this.objPaletteRam)[i] = value;
                    this.#paletteChanged(background, i);
                }
                if (io[index] & 0x80) io[index] = ((io[index] + 1) | 0x80) & 0xff;
                return;
            }
            case OPRI:
                // Only the boot ROM sets the sprite order; games just store the value.
                if (this.cgb) io[OPRI] = value;
                return;
        }
    }

    readRegister(reg) {
        const io = this.gb.io;
        switch (reg) {
            case STAT: return io[STAT] | 0x80;
            case 0x4f: return this.cgb ? this.vramBank | 0xfe : 0xff;
            case BCPS: case OCPS: return this.cgb ? io[reg] | 0x40 : 0xff;
            case 0x69: case 0x6b:
                if (!this.cgb || this.cgbPalettesBlocked) return 0xff;
                return (reg === 0x69 ? this.bgPaletteRam : this.objPaletteRam)[io[reg - 1] & 0x3f];
            case OPRI: return this.cgb ? io[OPRI] | 0xfe : 0xff;
            default: return io[reg];
        }
    }

    #paletteChanged(background, index) {
        const ram = background ? this.bgPaletteRam : this.objPaletteRam;
        const entry = index >> 1;
        const color = ram[entry * 2] | (ram[entry * 2 + 1] << 8);
        (background ? this.bgRgb : this.objRgb)[entry] = cgbToPixel(color, this.colorCorrection);
    }

    #writeLcdc(value) {
        const gb = this.gb;
        const io = gb.io;
        const old = io[LCDC];
        if (value & 0x80 && !(old & 0x80)) {
            // LCD turned on: the state machine starts over.
            this.cycles = 0;
            this.state = 0;
            this.cyclesForLine = 0;
            gb.doubleSpeedAlignment = 0;
            // The first frame isn't shown (a CGB repeats the last one).
            this.frameSkipped = !gb.sgb;
        } else if (!(value & 0x80) && old & 0x80) {
            gb.doubleSpeedAlignment = 0;
            this.#lcdOff();
        }
        // Disabling sprites while one is being fetched aborts the fetch (DMG).
        if (!this.cgb && old & 2 && !(value & 2) && this.duringObjectFetch) {
            this.cyclesForLine += Math.trunc(this.cycles / 2);
            this.cycles = 0;
            this.objectFetchAborted = true;
        }
        io[LCDC] = value;
        this.wyCheckScheduled = true;
    }

    #lcdOff() {
        const gb = this.gb;
        const io = gb.io;
        this.cyclesForLine = 0;
        this.state = 0;
        this.cycles = 0;
        // Switching off outside HBlank lets a waiting HBlank DMA block through.
        if (gb.hdmaOnHblank && io[STAT] & 3) gb.hdmaOn = true;
        io[LY] = 0;
        io[STAT] &= ~3;
        this.oamReadBlocked = false;
        this.vramReadBlocked = false;
        this.oamWriteBlocked = false;
        this.vramWriteBlocked = false;
        this.cgbPalettesBlocked = false;
        this.currentLine = 0;
        this.lyForComparison = 0;
        this.accessedOamRow = NONE_8;
        this.wyTriggered = false;
        this.front.fill(this.#blank());
    }

    // --- CPU access to VRAM and OAM ------------------------------------------------------

    /** A CPU read of VRAM (the PPU is in sync unless OAM DMA is running). */
    readVram(addr) {
        const gb = this.gb;
        if (this.vramReadBlocked && !gb.inDmaRead) return 0xff;
        // At the end of mode 3 the CPU's address can mix with the fetcher's.
        if (this.state === 22) {
            if (!this.cgb) {
                if (addr & 0x1000 && !(this.lastTileDataAddress & 0x1000)) addr &= ~0x1000;
            } else if (!gb.doubleSpeed) {
                if (addr & 0x1000) {
                    addr = this.lastTileIndexAddress;
                } else if (this.lastTileDataAddress & 0x1000) {
                    const value = this.cpuVramBus;
                    this.cpuVramBus = this.vram[(addr & 0x1fff) | (this.vramBank << 13)];
                    return value;
                } else {
                    addr = this.lastTileDataAddress;
                }
            }
        }
        return (this.cpuVramBus = this.vram[(addr & 0x1fff) | (this.vramBank << 13)]);
    }

    writeVram(addr, value) {
        if (this.vramWriteBlocked) return;
        this.vram[(addr & 0x1fff) | (this.vramBank << 13)] = value;
    }

    /** FEA0-FEFF and OAM outside of DMA and locks. */
    readOam(addr) {
        addr &= 0xff;
        if (addr < 0xa0) return this.oam[addr];
        return this.cgb ? (addr & 0xf0) | (addr >> 4) : 0;
    }

    /**
     * A CPU read of FE00-FEFF (the PPU is in sync). During OAM scan a DMG
     * corrupts OAM instead.
     */
    cpuReadOam(addr) {
        const gb = this.gb;
        if (this.oamWriteBlocked && !this.cgb) {
            this.oamBugRead(addr);
            return 0xff;
        }
        if (gb.dmaCurrentDest !== 0xa1 && (gb.dmaCurrentDest !== 0 || gb.dmaRestarting)) return 0xff;
        if (this.oamReadBlocked) {
            if (!this.cgb && addr < 0xfea0) this.#blockedReadGlitch(addr);
            return 0xff;
        }
        return this.readOam(addr);
    }

    cpuWriteOam(addr, value) {
        const gb = this.gb;
        const oam = this.oam;
        if (this.oamWriteBlocked) {
            this.triggerOamBug(addr);
            return;
        }
        if (gb.dmaCurrentDest !== 0xa1) return;
        const offset = addr & 0xff;
        if (this.cgb) {
            if (offset < 0xa0) oam[offset] = value;
            return;
        }
        if (offset < 0xa0) {
            const row = offset & 0xf8;
            if (this.accessedOamRow === 0xa0) {
                for (let i = 0; i < 8; i++) {
                    if ((i & 6) !== (offset & 6)) oam[row + i] = oam[0x98 + i];
                    else oam[row + i] = glitch(oam[row + i], oam[0x9c], oam[0x98 + i]);
                }
            }
            oam[offset] = value;
            if (this.accessedOamRow === 0) {
                oam[0] = glitch(oam[0], oam[row], oam[offset & 0xfe]);
                oam[1] = glitch(oam[1], oam[row + 1], oam[(offset & 0xfe) | 1]);
                for (let i = 2; i < 8; i++) oam[i] = oam[row + i];
            }
        } else if (this.accessedOamRow === 0) {
            oam[addr & 7] = value;
        }
    }

    /**
     * DMG OAM bug, write pattern: a write (or the CPU's 16-bit increment unit)
     * on FE00-FEFF while OAM scan reads a row corrupts that row.
     */
    triggerOamBug(addr) {
        if (this.cgb || addr < 0xfe00 || addr >= 0xff00) return;
        this.catchUp();
        const row = this.accessedOamRow;
        if (row === NONE_8 || row < 8) return;
        const w = this.#oamWords;
        const r = row >> 1;
        w[r] = glitch(w[r], w[r - 4], w[r - 2]);
        this.oam.copyWithin(row + 2, row - 6, row);
    }

    /** DMG OAM bug, read pattern (DMG-B; the PPU is in sync). */
    oamBugRead(addr) {
        if (this.cgb || addr < 0xfe00 || addr >= 0xff00) return;
        const row = this.accessedOamRow;
        if (row === NONE_8 || row < 8) return;
        const oam = this.oam;
        const w = this.#oamWords;
        const r = row >> 1;
        if ((row & 0x18) === 0x10) {
            if (row < 0x98) {
                w[r - 4] = glitchReadSecondary(w[r - 8], w[r - 4], w[r], w[r - 2]);
                oam.copyWithin(row - 0x10, row - 8, row);
            }
        } else if ((row & 0x18) === 0) {
            if (row < 0x98) {
                if (row === 0x40) {
                    w[r - 4] = glitchQuaternary(w[0], w[r], w[r - 2], w[r - 3], w[r - 4], w[r - 7], w[r - 8], w[r - 16]);
                } else {
                    const op = row === 0x20 ? glitchTertiary2 : row === 0x60 ? glitchTertiary3 : glitchTertiary1;
                    w[r - 4] = op(w[r], w[r - 2], w[r - 4], w[r - 8], w[r - 16]);
                }
                oam.copyWithin(row - 0x10, row - 8, row);
                oam.copyWithin(row - 0x20, row - 8, row);
            }
        } else {
            w[r - 4] = w[r] = glitchRead(w[r], w[r - 4], w[r - 2]);
        }
        oam.copyWithin(row, row - 8, row);
        if (row === 0x80) oam.copyWithin(0, row, row + 8);
    }

    /** A DMG read of OAM while it's locked, at the start or end of OAM scan. */
    #blockedReadGlitch(addr) {
        const oam = this.oam;
        const w = this.#oamWords;
        const row = addr & 0xf8;
        if (this.accessedOamRow === 0) {
            w[row >> 1] = w[0] = glitchRead(w[0], w[row >> 1], w[(addr & 0xff) >> 1]);
            for (let i = 2; i < 8; i++) oam[i] = oam[row + i];
        } else if (this.accessedOamRow === 0xa0) {
            const target = ((addr & 7) | 0x98) >> 1;
            const a = w[0x9c >> 1];
            const b = w[target];
            let c = w[row >> 1];
            switch (addr & 7) {
                case 0: case 1:
                    w[target] = (a & b) | (a & c) | (b & c);
                    break;
                case 2: case 3:
                    c = w[(addr & 0xfe) >> 1];
                    w[target] = (a & b) | (a & c) | (b & c);
                    break;
                case 6: case 7:
                    w[target] = glitchRead(a, b, c);
                    break;
            }
            for (let i = 0; i < 8; i++) oam[row + i] = oam[0x98 + i];
        }
    }

    // --- The state machine ------------------------------------------------------------

    /** Catches up with the CPU (GB_display_sync). */
    catchUp() {
        this.run(0, true);
    }

    /**
     * Advances by `cycles` (8 MHz units). Unless `force`d, mode 3 and OAM scan
     * may be left owed and done in one go later (batching).
     */
    run(cycles, force) {
        // The common cases: still inside a sleep, or waiting to do OAM scan or
        // mode 3 in one go.
        const owed = this.cycles + cycles;
        if ((owed <= 0 || (!force && owed < (this.state === 5 ? MODE2_LENGTH * 2 : this.state === 3 ? this.mode3BatchingLength * 2 : 0))) &&
            !this.wyCheckScheduled && !this.delayedGlitchHblankInterrupt && this.cyclesForLine < LINE_LENGTH - 8 &&
            !this.cpu.stopped) {
            this.cycles += cycles;
            this.cyclesSinceVblank += cycles >> 1;
            this.wyCheckModulo = (this.wyCheckModulo + cycles) & 0xff;
            return;
        }
        this.#run(cycles, force);
    }

    #run(cycles, force) {
        const gb = this.gb;
        const io = gb.io;
        const cgb = this.cgb;
        if (this.wyTriggered) {
            this.wyCheckScheduled = false;
        } else if (this.wyCheckScheduled) {
            // A WY or LCDC write is compared with LY a few T-cycles later.
            force = true;
            let toCheck;
            if (gb.doubleSpeed) toCheck = 8 - ((this.wyCheckModulo + 6) & 7);
            else if (cgb) toCheck = 8 - (this.wyCheckModulo & 7);
            else toCheck = 8 - ((this.wyCheckModulo + 2) & 7);
            if (cycles >= toCheck) {
                this.wyCheckScheduled = false;
                this.#run(toCheck, true);
                this.#wyCheck();
                if (this.state === 21 && cgb && !gb.doubleSpeed) this.wyJustChecked = true;
                cycles -= toCheck;
            }
        }

        // A line can't last longer than 456 dots: mode 3 is cut short.
        if (io[LCDC] & 0x80 && this.cyclesForLine * 2 + cycles + this.cycles > LINE_LENGTH * 2) {
            const firstBatch = Math.max(0, LINE_LENGTH * 2 - this.cyclesForLine * 2 + this.cycles);
            this.#run(firstBatch, force);
            cycles -= firstBatch;
            if (this.state === 22) {
                io[STAT] &= ~3;
                this.modeForInterrupt = 0;
                this.statUpdate();
            }
            this.state = 9;
            this.cycles = 0;
        }
        if (this.delayedGlitchHblankInterrupt && cycles && this.currentLine < LINES) {
            this.delayedGlitchHblankInterrupt = false;
            this.modeForInterrupt = 0;
            this.statUpdate();
            this.modeForInterrupt = 3;
        }
        this.cyclesSinceVblank += cycles >> 1;
        this.wyCheckModulo = (this.wyCheckModulo + cycles) & 0xff;

        // The DMG's PPU doesn't advance in STOP mode.
        if (gb.cpu.stopped && !cgb) {
            if (this.cyclesSinceVblank >= FRAME_LENGTH) this.#vblank();
            return;
        }

        const allowBatching = !force;
        this.cycles += cycles;
        if (this.cycles <= 0) return;
        this.runCycles = cycles;
        for (;;) {
            switch (this.state) {
                case 0:
                    this.wyCheckModulo = cycles & 0xff;
                    this.wyJustChecked = false;
                    if (!(io[LCDC] & 0x80)) {
                        this.state = S.LCD_OFF;
                        continue;
                    }
                    if (!cgb) {
                        this.cycles -= 2;
                        if (this.cycles <= 0) {
                            this.state = 23;
                            return;
                        }
                    }
                    // falls through
                case 23:
                    // Line 0 after the LCD is switched on: no OAM scan.
                    this.currentLine = 0;
                    this.windowY = 0xff;
                    this.wyTriggered = false;
                    this.positionInLine = 0xf0;
                    this.lineHasFractionalScrolling = false;
                    this.lyForComparison = 0;
                    io[STAT] &= ~3;
                    this.modeForInterrupt = NONE_8;
                    this.oamReadBlocked = false;
                    this.vramReadBlocked = false;
                    this.oamWriteBlocked = false;
                    this.vramWriteBlocked = false;
                    this.cgbPalettesBlocked = false;
                    this.cyclesForLine = MODE2_LENGTH - 4;
                    this.statUpdate();
                    this.cycles -= (MODE2_LENGTH - 4) * 2;
                    if (this.cycles <= 0) {
                        this.state = 2;
                        return;
                    }
                    // falls through
                case 2:
                    this.oamWriteBlocked = true;
                    this.cyclesForLine += 2;
                    this.statUpdate();
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 34;
                        return;
                    }
                    // falls through
                case 34:
                    this.nVisibleObjs = 0;
                    this.origNVisibleObjs = 0;
                    // Mode 0 is shorter on this line.
                    this.cyclesForLine += 8;
                    io[STAT] = (io[STAT] & ~3) | 3;
                    this.modeForInterrupt = 3;
                    this.oamWriteBlocked = true;
                    this.oamReadBlocked = true;
                    this.vramReadBlocked = !cgb || gb.doubleSpeed;
                    this.vramWriteBlocked = !cgb || gb.doubleSpeed;
                    this.cyclesForLine += 2;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 37;
                        return;
                    }
                    // falls through
                case 37:
                    this.cgbPalettesBlocked = true;
                    this.cyclesForLine += 3;
                    this.cycles -= 6;
                    if (this.cycles <= 0) {
                        this.state = 38;
                        return;
                    }
                    // falls through
                case 38:
                    this.vramReadBlocked = true;
                    this.vramWriteBlocked = true;
                    this.wxTriggered = false;
                    this.state = S.MODE3;
                    continue;

                case S.LCD_OFF:
                    // While the LCD is off, a frame still ends every 70224 dots.
                    if (this.cyclesSinceVblank < FRAME_LENGTH) {
                        this.cycles -= (FRAME_LENGTH - this.cyclesSinceVblank) * 2;
                        if (this.cycles <= 0) {
                            this.state = 1;
                            return;
                        }
                    }
                    // falls through
                case 1:
                    this.#vblank();
                    this.state = S.LCD_OFF;
                    continue;

                case 9: {
                    // Mode 3 cut short at the end of the line.
                    if (this.currentLine < LINES && !gb.sgb) {
                        const color = cgb ? WHITE : this.#blank();
                        const base = this.currentLine * SCREEN_WIDTH;
                        for (; this.lcdX < SCREEN_WIDTH; this.lcdX++) this.back[base + this.lcdX] = color;
                    }
                    this.nVisibleObjs = this.origNVisibleObjs;
                    this.currentLine = (this.currentLine + 1) & 0xff;
                    this.#wyCheck();
                    this.cyclesForLine = 0;
                    if (this.currentLine !== LINES) {
                        this.cyclesForLine = 2;
                        this.cycles -= 4;
                        if (this.cycles <= 0) {
                            this.state = 28;
                            return;
                        }
                        this.state = 28;
                        continue;
                    }
                    if (this.positionInLine >= 156 && this.positionInLine < 0xf0) this.delayedGlitchHblankInterrupt = true;
                    this.positionInLine = 0xf0;
                    this.lineHasFractionalScrolling = false;
                    this.state = S.LINES;
                    continue;
                }
                case 28:
                    io[LY] = this.currentLine;
                    if (this.positionInLine >= 156 && this.positionInLine < 0xf0) this.delayedGlitchHblankInterrupt = true;
                    this.statUpdate();
                    this.positionInLine = 0xf1;
                    this.state = S.MODE3;
                    continue;

                // --- Lines 0-143 ---------------------------------------------------
                case S.LINES:
                    if (this.currentLine >= LINES) {
                        this.state = S.VBLANK_LINES;
                        continue;
                    }
                    // falls through
                case S.LINE:
                    this.#wyCheck();
                    this.oamWriteBlocked = cgb && !gb.doubleSpeed;
                    this.accessedOamRow = 0;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 35;
                        return;
                    }
                    // falls through
                case 35:
                    this.oamWriteBlocked = cgb;
                    this.cycles -= 2;
                    if (this.cycles <= 0) {
                        this.state = 6;
                        return;
                    }
                    // falls through
                case 6:
                    io[LY] = this.currentLine;
                    this.oamReadBlocked = true;
                    this.lyForComparison = this.currentLine ? NONE_16 : 0;
                    // The OAM interrupt fires a T-cycle before STAT changes, except on line 0.
                    if (this.currentLine !== 0) {
                        this.modeForInterrupt = 2;
                        io[STAT] &= ~3;
                    } else if (!cgb) {
                        io[STAT] &= ~3;
                    }
                    this.statUpdate();
                    this.cycles -= 2;
                    if (this.cycles <= 0) {
                        this.state = 7;
                        return;
                    }
                    // falls through
                case 7:
                    this.oamReadBlocked = true;
                    io[STAT] = (io[STAT] & ~3) | 2;
                    this.modeForInterrupt = 2;
                    this.oamWriteBlocked = true;
                    this.lyForComparison = this.currentLine;
                    this.#wyCheck();
                    this.statUpdate();
                    this.modeForInterrupt = NONE_8;
                    this.statUpdate();
                    this.nVisibleObjs = 0;
                    this.origNVisibleObjs = 0;
                    if (gb.dmaCurrentDest !== 0xa1 || this.oamPpuBlocked) {
                        this.state = S.OAM_SCAN;
                        continue;
                    }
                    // falls through
                case 5:
                    if (allowBatching && this.cycles < MODE2_LENGTH * 2) {
                        this.state = 5;
                        return;
                    }
                    // falls through
                case S.OAM_SCAN:
                    this.oamSearchIndex = 0;
                    // falls through
                case S.OAM_ENTRY:
                    if (this.oamSearchIndex >= 40) {
                        this.state = S.OAM_DONE;
                        continue;
                    }
                    if (cgb) this.#addObject(this.oamSearchIndex);
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 8;
                        return;
                    }
                    // falls through
                case 8:
                    if (!cgb) {
                        this.#addObject(this.oamSearchIndex);
                        this.accessedOamRow = (this.oamSearchIndex & ~1) * 4 + 8;
                    }
                    if (this.oamSearchIndex === 37) {
                        this.vramReadBlocked = !cgb;
                        this.vramWriteBlocked = false;
                        this.cgbPalettesBlocked = false;
                        this.oamWriteBlocked = cgb;
                    }
                    this.oamSearchIndex++;
                    this.state = S.OAM_ENTRY;
                    continue;
                case S.OAM_DONE:
                    this.cyclesForLine = MODE2_LENGTH + 4;
                    this.origNVisibleObjs = this.nVisibleObjs;
                    this.accessedOamRow = NONE_8;
                    io[STAT] = (io[STAT] & ~3) | 3;
                    this.modeForInterrupt = 3;
                    this.vramReadBlocked = true;
                    this.vramWriteBlocked = true;
                    this.cgbPalettesBlocked = false;
                    this.oamWriteBlocked = true;
                    this.oamReadBlocked = true;
                    this.statUpdate();
                    this.cyclesForLine += 3;
                    this.cycles -= 6;
                    if (this.cycles <= 0) {
                        this.state = 10;
                        return;
                    }
                    // falls through
                case 10:
                    this.cgbPalettesBlocked = true;
                    this.cyclesForLine += 2;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 32;
                        return;
                    }
                    // falls through
                case 32:
                case S.MODE3:
                    this.disableWindowPixelInsertionGlitch = false;
                    this.bgFifo.clear();
                    this.oamFifo.clear();
                    // 8 pixels of junk, dropped anyway.
                    this.bgFifo.pushBgRow(0, 0, 0, 0, false);
                    this.lcdX = 0;
                    this.fetcherState = Fetch.TILE_1;
                    this.mode3BatchingLength = this.#mode3BatchingLength();
                    if (!this.mode3BatchingLength) {
                        this.state = S.PIXEL;
                        continue;
                    }
                    // falls through
                case 3:
                    if (allowBatching && this.cycles < this.mode3BatchingLength * 2) {
                        this.state = 3;
                        return;
                    }
                    if (this.cycles >> 1 < this.mode3BatchingLength) {
                        this.state = S.PIXEL;
                        continue;
                    }
                    // Nothing could see the line being drawn: draw it at once.
                    this.lcdX = this.positionInLine = 160;
                    this.cyclesForLine += this.mode3BatchingLength;
                    this.#renderLine();
                    this.cycles -= this.mode3BatchingLength * 2;
                    if (this.cycles <= 0) {
                        this.state = 4;
                        return;
                    }
                    // falls through
                case 4:
                    this.state = S.HBLANK;
                    continue;

                // --- Mode 3, a dot at a time ------------------------------------------
                case S.PIXEL: {
                    this.wx166InterruptGlitch = false;
                    const wx = io[WX];
                    const position = this.positionInLine;
                    if (this.wyJustChecked) {
                        this.wyJustChecked = false;
                    } else if (!this.wxTriggered && this.wyTriggered && io[LCDC] & 0x20) {
                        let activate = false;
                        if (wx === 0) {
                            if (position === 0xf9) activate = true;
                            else if (position === 0xf0 && io[SCX] & 7) activate = true;
                            else if (position >= 0xf1 && position <= 0xf8) activate = true;
                        } else if (wx < 166 + (cgb ? 1 : 0)) {
                            if (wx === ((position + 7) & 0xff)) {
                                activate = true;
                            } else if (!cgb && wx === ((position + 6) & 0xff) && !this.wxJustChanged) {
                                activate = true;
                                // The LCD and the PPU fall out of step (DMG).
                                if (!gb.sgb && this.lcdX > 0) this.lcdX--;
                            }
                        }
                        if (activate) {
                            this.windowY = (this.windowY + 1) & 0xff;
                            this.windowTileX = 0;
                            this.bgFifo.clear();
                            if (wx === 0 && io[SCX] & 7 && !cgb) {
                                this.cyclesForLine += 1;
                                this.cycles -= 2;
                                if (this.cycles <= 0) {
                                    this.state = 42;
                                    return;
                                }
                            } else if (wx === 166) {
                                this.wx166InterruptGlitch = true;
                            }
                            this.state = 42;
                            continue;
                        } else if (!cgb && wx === 166 && wx === ((position + 7) & 0xff)) {
                            this.windowY = (this.windowY + 1) & 0xff;
                        }
                    }
                    this.state = S.OBJECTS;
                    continue;
                }
                case 42:
                    this.wxTriggered = true;
                    this.fetcherState = Fetch.TILE_1;
                    this.windowIsBeingFetched = true;
                    // falls through
                case S.OBJECTS: {
                    const wx = io[WX];
                    if (wx === ((this.positionInLine + 7) & 0xff) && (!cgb || wx === 0) && this.wxTriggered &&
                        !this.windowIsBeingFetched && this.fetcherState === Fetch.TILE_1 && this.bgFifo.size === 8) {
                        // A pixel is inserted at the FIFO's end.
                        this.insertBgPixel = true;
                    }
                    // Sprites: skipped entirely with sprites off on a DMG; the CGB
                    // checks LCDC.1 only when pixels are popped.
                    while (this.nVisibleObjs !== 0 && this.objectsX[this.nVisibleObjs - 1] < this.#xForObjectMatch()) {
                        this.nVisibleObjs--;
                    }
                    this.duringObjectFetch = true;
                    // falls through
                }
                case S.OBJECT:
                    if (this.nVisibleObjs === 0 || !(io[LCDC] & 2 || cgb) ||
                        this.objectsX[this.nVisibleObjs - 1] !== this.#xForObjectMatch()) {
                        this.state = S.PIXEL_OUT;
                        continue;
                    }
                    // falls through
                case S.OBJECT_WAIT:
                    if (this.fetcherState < Fetch.HIGH_2 || this.bgFifo.size === 0) {
                        this.#advanceFetcher();
                        this.cyclesForLine++;
                        this.cycles -= 2;
                        if (this.cycles <= 0) {
                            this.state = 27;
                            return;
                        }
                        this.state = 27;
                        continue;
                    }
                    this.state = S.OBJECT_FETCH;
                    continue;
                case 27:
                    this.state = this.objectFetchAborted ? S.PIXEL_OUT : S.OBJECT_WAIT;
                    continue;
                case S.OBJECT_FETCH:
                    this.#advanceFetcher();
                    this.cyclesForLine++;
                    this.cycles -= 2;
                    if (this.cycles <= 0) {
                        this.state = 41;
                        return;
                    }
                    // falls through
                case 41: {
                    if (this.objectFetchAborted) {
                        this.state = S.PIXEL_OUT;
                        continue;
                    }
                    this.#advanceFetcher();
                    this.#dmaSync();
                    const index = this.visibleObjs[this.nVisibleObjs - 1] * 4;
                    this.mode2YBus = this.#oamRead(index + 2);
                    this.mode2XBus = this.#oamRead(index + 3);
                    this.cyclesForLine += 2;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 20;
                        return;
                    }
                }
                // falls through
                case 20:
                    if (this.objectFetchAborted) {
                        this.state = S.PIXEL_OUT;
                        continue;
                    }
                    this.#dmaSync();
                    this.objectLowLineAddress = this.#objectLineAddress(this.objectsY[this.nVisibleObjs - 1],
                        this.mode2YBus, this.mode2XBus);
                    this.objectTileData[0] = this.#vramRead(this.objectLowLineAddress);
                    this.cyclesForLine += 2;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 39;
                        return;
                    }
                    // falls through
                case 39:
                    if (this.objectFetchAborted) {
                        this.state = S.PIXEL_OUT;
                        continue;
                    }
                    this.duringObjectFetch = false;
                    this.cyclesForLine++;
                    this.objectLowLineAddress = this.#objectLineAddress(this.objectsY[this.nVisibleObjs - 1],
                        this.mode2YBus, this.mode2XBus);
                    this.#dmaSync();
                    this.objectTileData[1] = this.#vramRead(this.objectLowLineAddress + 1);
                    this.cycles -= 2;
                    if (this.cycles <= 0) {
                        this.state = 40;
                        return;
                    }
                    // falls through
                case 40: {
                    const flags = this.mode2XBus;
                    const palette = cgb ? flags & 7 : (flags & 0x10) >> 4;
                    this.oamFifo.overlayObjectRow(this.objectTileData[0], this.objectTileData[1], palette, flags & 0x80,
                        this.objectPriority === Priority.INDEX ? this.visibleObjs[this.nVisibleObjs - 1] : 0, flags & 0x20);
                    this.dataForSelGlitch = this.vramPpuBlocked ? 0xff : this.vram[this.objectLowLineAddress + 1];
                    this.nVisibleObjs--;
                    this.state = S.OBJECT;
                    continue;
                }
                case S.PIXEL_OUT:
                    this.objectFetchAborted = false;
                    this.duringObjectFetch = false;
                    this.#renderPixel();
                    this.#advanceFetcher();
                    if (this.positionInLine === 160) {
                        this.state = S.HBLANK;
                        continue;
                    }
                    this.cyclesForLine++;
                    this.cycles -= 2;
                    if (this.cycles <= 0) {
                        this.state = 21;
                        return;
                    }
                    // falls through
                case 21:
                    if (this.wx166InterruptGlitch) {
                        this.modeForInterrupt = 0;
                        this.statUpdate();
                    }
                    this.state = S.PIXEL;
                    continue;

                // --- HBlank ----------------------------------------------------------
                case S.HBLANK: {
                    this.positionInLine = 0xf0;
                    this.lineHasFractionalScrolling = false;
                    if (this.fetcherState === Fetch.HIGH_1 || this.fetcherState === Fetch.HIGH_2) {
                        // current_tile_data[1] holds the last tile data byte read.
                        this.currentTileData[1] = this.currentTileData[0];
                    }
                    if (this.lcdX !== 160 && !gb.sgb && this.currentLine < LINES) {
                        // The PPU and the LCD fell out of step: the rest of the line repeats the last color.
                        const base = this.currentLine * SCREEN_WIDTH;
                        for (; this.lcdX < 160; this.lcdX++) {
                            this.back[base + this.lcdX] = this.lcdX === 0 ? this.bgRgb[0] : this.back[base + this.lcdX - 1];
                        }
                    }
                    if (this.currentLine === LINES - 1) this.windowY = 0xff;
                    if (!cgb && this.wyTriggered && io[LCDC] & 0x20 && io[WX] === 166) {
                        this.wxTriggered = true;
                        this.windowTileX = 1;
                        this.windowY = (this.windowY + 1) & 0xff;
                    } else {
                        this.wxTriggered = false;
                    }
                    if (!gb.doubleSpeed) {
                        io[STAT] &= ~3;
                        this.modeForInterrupt = 0;
                        this.oamReadBlocked = cgb;
                        this.vramReadBlocked = false;
                        this.oamWriteBlocked = false;
                        this.vramWriteBlocked = false;
                    }
                    this.cyclesForLine++;
                    this.cycles -= 2;
                    if (this.cycles <= 0) {
                        this.state = 22;
                        return;
                    }
                }
                // falls through
                case 22:
                    io[STAT] &= ~3;
                    this.modeForInterrupt = 0;
                    this.oamReadBlocked = false;
                    this.vramReadBlocked = false;
                    this.oamWriteBlocked = false;
                    this.vramWriteBlocked = false;
                    this.statUpdate();
                    this.cyclesForLine += 2;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 33;
                        return;
                    }
                    // falls through
                case 33:
                    this.cgbPalettesBlocked = !gb.doubleSpeed;
                    if (gb.hdmaOnHblank && !gb.cpu.halted && !gb.cpu.stopped) gb.hdmaOn = true;
                    this.cyclesForLine += 2;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 36;
                        return;
                    }
                    // falls through
                case 36: {
                    this.cgbPalettesBlocked = false;
                    if (this.cyclesForLine > LINE_LENGTH - 2) {
                        this.cyclesForLine = 0;
                        this.cycles -= LINE_LENGTH * 2;
                        if (this.cycles <= 0) {
                            this.state = 43;
                            return;
                        }
                        this.state = 9;
                        continue;
                    }
                    const elapsed = this.cyclesForLine;
                    this.cyclesForLine = 0;
                    this.cycles -= (LINE_LENGTH - elapsed - 2) * 2;
                    if (this.cycles <= 0) {
                        this.state = 11;
                        return;
                    }
                }
                // falls through
                case 11:
                    this.cyclesForLine = 0;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 31;
                        return;
                    }
                    // falls through
                case 31:
                    if (this.currentLine !== LINES - 1) this.modeForInterrupt = 2;
                    this.currentLine = (this.currentLine + 1) & 0xff;
                    this.state = S.LINES;
                    continue;
                case 43:
                    this.state = 9;
                    continue;

                // --- Lines 144-152 -----------------------------------------------------
                case S.VBLANK_LINES:
                    if (this.currentLine >= 153) {
                        this.state = S.LINE_153;
                        continue;
                    }
                    this.lyForComparison = NONE_16;
                    this.statUpdate();
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 26;
                        return;
                    }
                    // falls through
                case 26:
                    io[LY] = this.currentLine;
                    if (this.currentLine === LINES && !this.statInterruptLine && io[STAT] & 0x20) io[IF] |= 2;
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 12;
                        return;
                    }
                    // falls through
                case 12:
                    if (this.delayedGlitchHblankInterrupt) {
                        this.delayedGlitchHblankInterrupt = false;
                        this.modeForInterrupt = 0;
                    }
                    this.lyForComparison = this.currentLine;
                    this.statUpdate();
                    this.cycles -= 2;
                    if (this.cycles <= 0) {
                        this.state = 24;
                        return;
                    }
                    // falls through
                case 24:
                    if (this.currentLine === LINES) {
                        // VBlank also triggers the OAM interrupt.
                        io[STAT] = (io[STAT] & ~3) | 1;
                        io[IF] |= 1;
                        if (!this.statInterruptLine && io[STAT] & 0x20) io[IF] |= 2;
                        this.modeForInterrupt = 1;
                        this.statUpdate();
                        this.#vblank();
                    }
                    this.cycles -= (LINE_LENGTH - 5) * 2;
                    if (this.cycles <= 0) {
                        this.state = 13;
                        return;
                    }
                    // falls through
                case 13:
                    this.currentLine++;
                    this.state = S.VBLANK_LINES;
                    continue;

                // --- Line 153: LY reads 0 early ----------------------------------------
                case S.LINE_153:
                    this.lyForComparison = NONE_16;
                    this.statUpdate();
                    this.cycles -= 4;
                    if (this.cycles <= 0) {
                        this.state = 19;
                        return;
                    }
                    // falls through
                case 19:
                    io[LY] = 153;
                    this.cycles -= cgb ? 4 : 8;
                    if (this.cycles <= 0) {
                        this.state = 14;
                        return;
                    }
                    // falls through
                case 14:
                    if (!cgb && !gb.doubleSpeed) io[LY] = 0;
                    this.lyForComparison = 153;
                    this.statUpdate();
                    this.cycles -= cgb ? 8 : 4;
                    if (this.cycles <= 0) {
                        this.state = 15;
                        return;
                    }
                    // falls through
                case 15:
                    io[LY] = 0;
                    this.lyForComparison = cgb || gb.doubleSpeed ? 153 : NONE_16;
                    this.statUpdate();
                    this.cycles -= 8;
                    if (this.cycles <= 0) {
                        this.state = 16;
                        return;
                    }
                    // falls through
                case 16:
                    this.lyForComparison = 0;
                    this.statUpdate();
                    this.cycles -= 24;
                    if (this.cycles <= 0) {
                        this.state = 29;
                        return;
                    }
                    // falls through
                case 29:
                    this.cycles -= (LINE_LENGTH - 24) * 2;
                    if (this.cycles <= 0) {
                        this.state = 17;
                        return;
                    }
                    // falls through
                case 17:
                    this.currentLine = 0;
                    this.wyTriggered = false;
                    this.state = S.LINE;
                    continue;

                default:
                    throw new Error(`PPU state ${this.state}`);
            }
        }
    }

    /** 8 MHz units (at least) before the state machine does anything (0: it may now). */
    get quietUnits() {
        if (this.wyCheckScheduled || this.delayedGlitchHblankInterrupt || this.cyclesForLine >= LINE_LENGTH - 8) return 0;
        if (this.cycles <= 0) return -this.cycles;
        // Waiting to do OAM scan or mode 3 in one go.
        if (this.state === 5) return MODE2_LENGTH * 2 - 1 - this.cycles;
        if (this.state === 3) return Math.max(0, this.mode3BatchingLength * 2 - 1 - this.cycles);
        return 0;
    }

    /** End of a frame (or 70224 dots with the LCD off): the frame is shown. */
    #vblank() {
        this.cyclesSinceVblank = 0;
        this.frameDone = true;
        if (!(this.gb.io[LCDC] & 0x80)) {
            this.front.fill(this.#blank());
        } else if (this.frameSkipped) {
            this.frameSkipped = false;
        } else {
            [this.front, this.back] = [this.back, this.front];
            [this.frontBytes, this.backBytes] = [this.backBytes, this.frontBytes];
        }
    }

    /** How long mode 3 can be done in one go (0: dot by dot). */
    #mode3BatchingLength() {
        const gb = this.gb;
        const io = gb.io;
        if (this.positionInLine !== 0xf0) return 0;
        if (gb.hdmaOn || gb.cpu.stopped || gb.dmaCurrentDest !== 0xa1 || this.wxTriggered) return 0;
        const wx = io[WX];
        if (this.wyTriggered) {
            if (io[LCDC] & 0x20) {
                if (wx < 7 || wx === 166 || wx === 167) return 0;
            } else if (wx < 167 && !this.cgb) {
                return 0;
            }
        }
        // No sprites or window: the length is known.
        if (this.nVisibleObjs === 0 && !(this.wyTriggered && io[LCDC] & 0x20)) return 167 + (io[SCX] & 7);
        if (gb.hdmaOnHblank) return 0;
        // Otherwise, only when nothing can see when mode 3 ends (300 dots is
        // more than it can last).
        if (!(io[STAT] & 8) || !(gb.ie & 2)) return 300;
        return 0;
    }

    #xForObjectMatch() {
        const x = (this.positionInLine + 8) & 0xff;
        return x > 0xf0 ? 0 : x;
    }

    /** OAM scan: adds the sprite at `index` to the line's if it's on the line. */
    #addObject(index) {
        const gb = this.gb;
        if (gb.dmaCurrentDest === 0xa1 && !this.oamPpuBlocked) {
            this.mode2YBus = this.oam[index * 4];
            this.mode2XBus = this.oam[index * 4 + 1];
            if (this.nVisibleObjs === 10) return;
        } else {
            const halted = this.cpu.halted || this.cpu.stopped;
            const dmaActive = gb.dmaCurrentDest !== 0xa1;
            if (!dmaActive || halted) {
                this.mode2YBus = this.#oamRead(index * 4);
                this.mode2XBus = this.#oamRead(index * 4 + 1);
            }
            if (this.nVisibleObjs === 10) return;
            if (dmaActive && halted && !this.cgb) return;
            if (this.oamPpuBlocked) return;
        }
        const height = gb.io[LCDC] & 4 ? 16 : 8;
        const y = this.mode2YBus - 16;
        const line = this.currentLine;
        if (y <= line && y + height > line) {
            // Kept sorted by X, last first.
            const n = this.nVisibleObjs;
            let j = 0;
            while (j < n && this.objectsX[j] > this.mode2XBus) j++;
            this.visibleObjs.copyWithin(j + 1, j, n);
            this.objectsX.copyWithin(j + 1, j, n);
            this.objectsY.copyWithin(j + 1, j, n);
            this.visibleObjs[j] = index;
            this.objectsX[j] = this.mode2XBus;
            this.objectsY[j] = this.mode2YBus;
            this.nVisibleObjs = n + 1;
        }
    }

    /** The PPU's OAM reads; OAM DMA puts its own bytes on the bus. */
    #oamRead(addr) {
        const gb = this.gb;
        if (this.oamPpuBlocked) return 0xff;
        const dest = gb.dmaCurrentDest;
        if (dest <= 0xa0 && dest > 0) {
            if (gb.hdmaInProgress) return this.readOam((gb.hdmaCurrentSrc & ~1) | (addr & 1));
            if (dest !== 0xa0) return this.oam[(dest & ~1) | (addr & 1)];
        }
        return this.oam[addr];
    }

    /** The PPU's VRAM reads; HDMA and OAM DMA from VRAM get in the way. */
    #vramRead(addr) {
        const gb = this.gb;
        if (this.vramPpuBlocked) return 0xff;
        if (gb.hdmaInProgress) {
            gb.addrForHdmaConflict = addr;
            return 0;
        }
        if (gb.dmaCurrentDest <= 0xa0 && gb.dmaCurrentDest > 0 && (gb.dmaCurrentSrc & 0xe000) === 0x8000) {
            // OAM DMA from VRAM: the addresses mix.
            const halted = gb.cpu.halted || gb.cpu.stopped;
            const offset = halted ? 0 : 1;
            const source = (gb.dmaCurrentSrc - offset) & 0x1fff;
            if (this.cgb) {
                if (gb.dmaPpuVramConflict) {
                    addr = (gb.dmaPpuVramConflictAddr & 0x1fff) | (addr & 0x2000);
                } else if (gb.dmaCyclesModulo && !halted) {
                    addr = (addr & 0x2000) | source;
                } else {
                    addr &= 0x2000 | source;
                    gb.dmaPpuVramConflictAddr = addr;
                    gb.dmaPpuVramConflict = !halted;
                }
            } else {
                addr |= source;
            }
            this.oam[gb.dmaCurrentDest - offset] = this.vram[(addr & 0x1fff) | (this.vramBank << 13)];
        }
        return this.vram[addr];
    }

    /** Runs OAM DMA up to the current dot (it normally runs after the PPU each M-cycle). */
    #dmaSync() {
        const gb = this.gb;
        if (gb.dmaCurrentDest === 0xa1) return;
        let offset = this.runCycles - this.cycles;
        if (offset <= 0) return;
        this.runCycles = this.cycles;
        if (!gb.doubleSpeed) offset >>= 1;
        const old = gb.dmaCycles;
        gb.dmaCycles = offset;
        gb.dmaRun();
        gb.dmaCycles = Math.max(0, old - offset);
    }

    #objectLineAddress(y, tile, flags) {
        const tall = (this.gb.io[LCDC] & 4) !== 0;
        let tileY = (this.currentLine - y) & (tall ? 15 : 7);
        if (flags & 0x40) tileY ^= tall ? 15 : 7;
        let address = (tall ? tile & 0xfe : tile) * 16 + tileY * 2;
        if (this.cgb && flags & 8) address += 0x2000;
        return address;
    }

    #fetcherY() {
        return this.wxTriggered ? this.windowY : (this.currentLine + this.gb.io[SCY]) & 0xff;
    }

    #tileAddress(y) {
        const tile = this.currentTile;
        this.lastTileset = (this.gb.io[LCDC] & 0x10) !== 0;
        let address = this.lastTileset ? tile * 16 : ((tile << 24) >> 24) * 16 + 0x1000;
        if (this.currentTileAttributes & 8) address += 0x2000;
        const yFlip = this.currentTileAttributes & 0x40 ? 7 : 0;
        return address + ((y & 7) ^ yFlip) * 2;
    }

    /** Tile data while LCDC.4 is cleared mid-fetch (Matt Currie's research); -1: read VRAM. */
    #tileSelGlitchData() {
        if (this.lastTileset) return this.currentTile & 0x80 ? -1 : this.currentTile;
        return this.dataForSelGlitch;
    }

    /** One dot of the background/window fetcher. */
    #advanceFetcher() {
        const io = this.gb.io;
        switch (this.fetcherState) {
            case Fetch.TILE_1: {
                this.updateWxGlitch();
                if (!(io[LCDC] & 0x20)) this.wxTriggered = false;
                let map = 0x1800;
                if (io[LCDC] & 0x08 && !this.wxTriggered) map = 0x1c00;
                else if (io[LCDC] & 0x40 && this.wxTriggered) map = 0x1c00;
                const y = this.#fetcherY();
                let x;
                if (this.wxTriggered) {
                    x = this.windowTileX;
                } else if (((this.positionInLine + 16) & 0xff) < 8) {
                    x = io[SCX] >> 3;
                } else {
                    const late = this.cgb && !this.duringObjectFetch ? 1 : 0;
                    x = ((io[SCX] + this.positionInLine + 8 - late) >> 3) & 0x1f;
                }
                // The CGB-D and later cache Y, so tiles can't be mixed.
                if (this.cgb) this.fetcherY = y;
                this.lastTileIndexAddress = map + x + (y >> 3) * 32;
                this.fetcherState++;
                break;
            }
            case Fetch.TILE_2:
                if (!this.cgbWxGlitch) {
                    this.#dmaSync();
                    this.currentTile = this.#vramRead(this.lastTileIndexAddress);
                    // The CGB reads the tile and its attributes at once.
                    if (this.cgb) this.currentTileAttributes = this.#vramRead(this.lastTileIndexAddress + 0x2000);
                }
                this.fetcherState++;
                break;
            case Fetch.LOW_1:
                this.updateWxGlitch();
                this.lastTileDataAddress = this.#tileAddress(this.cgb ? this.fetcherY : this.#fetcherY());
                this.fetcherState++;
                break;
            case Fetch.LOW_2: {
                if (this.cgbWxGlitch) {
                    this.currentTileData[0] = this.currentTileData[1];
                    this.fetcherState++;
                    break;
                }
                this.#dmaSync();
                const glitched = this.tileSelGlitch ? this.#tileSelGlitchData() : -1;
                this.currentTileData[0] = glitched >= 0 ? glitched : this.#vramRead(this.lastTileDataAddress);
                if (this.lastTileset && this.tileSelGlitch) this.dataForSelGlitch = this.#vramRead(this.lastTileDataAddress);
                this.fetcherState++;
                break;
            }
            case Fetch.HIGH_1:
                this.updateWxGlitch();
                this.lastTileDataAddress = this.#tileAddress(this.cgb ? this.fetcherY : this.#fetcherY()) + 1;
                this.fetcherState++;
                break;
            case Fetch.HIGH_2: {
                if (this.cgbWxGlitch) {
                    this.currentTileData[1] = this.currentTileData[0];
                    this.fetcherState++;
                    if (this.wxTriggered) this.windowTileX = (this.windowTileX + 1) & 0x1f;
                    break;
                }
                this.#dmaSync();
                const glitched = this.tileSelGlitch ? this.#tileSelGlitchData() : -1;
                if (glitched >= 0) {
                    this.currentTileData[1] = glitched;
                } else {
                    this.currentTileData[1] = this.#vramRead(this.lastTileDataAddress);
                    this.dataForSelGlitch = this.currentTileData[1];
                }
                if (this.lastTileset && this.tileSelGlitch) this.dataForSelGlitch = this.#vramRead(this.lastTileDataAddress);
                if (this.wxTriggered) this.windowTileX = (this.windowTileX + 1) & 0x1f;
                this.#push();
                break;
            }
            default:
                this.#push();
        }
    }

    #push() {
        const io = this.gb.io;
        this.fetcherState = Fetch.PUSH;
        const fifo = this.bgFifo;
        if (fifo.size > 0) return;
        if (this.wyTriggered && !(io[LCDC] & 0x20) && !this.cgb && !this.disableWindowPixelInsertionGlitch) {
            // The window, though disabled, still inserts a pixel (SameBoy issue #278).
            let position = (this.positionInLine + 7) & 0xff;
            if (position > 167) position = 0;
            if (io[WX] === position) {
                fifo.readEnd = (fifo.readEnd - 1) & 7;
                const i = fifo.readEnd;
                fifo.pixel[i] = 0;
                fifo.palette[i] = 0;
                fifo.priority[i] = 0;
                fifo.bgPriority[i] = 0;
                fifo.size = 1;
                return;
            }
        }
        const attributes = this.currentTileAttributes;
        fifo.pushBgRow(this.currentTileData[0], this.currentTileData[1], attributes & 7, attributes & 0x80, (attributes & 0x20) !== 0);
        this.fetcherState = Fetch.TILE_1;
    }

    /** Pops a pixel from the FIFOs onto the screen, if it can. */
    #renderPixel() {
        const io = this.gb.io;
        const cgb = this.cgb;
        // Nothing moves while a sprite at X = 0 is pending.
        if (this.nVisibleObjs !== 0 && (io[LCDC] & 2 || cgb) && this.objectsX[this.nVisibleObjs - 1] === 0) return;
        const bg = this.bgFifo;
        if (bg.size === 0) return;
        let pixel = 0;
        let bgPalette = 0;
        let bgPriority = 0;
        if (this.insertBgPixel) {
            this.insertBgPixel = false;
        } else {
            const i = bg.pop();
            pixel = bg.pixel[i];
            bgPalette = bg.palette[i];
            bgPriority = bg.bgPriority[i];
        }
        let drawObject = false;
        let objectPixel = 0;
        let objectPalette = 0;
        const objects = this.oamFifo;
        if (objects.size) {
            const i = objects.pop();
            objectPixel = objects.pixel[i];
            objectPalette = objects.palette[i];
            if (objectPixel && io[LCDC] & 2) {
                drawObject = true;
                bgPriority |= objects.bgPriority[i];
            }
        }

        const position = this.positionInLine;
        if (((position + 16) & 0xff) < 8) {
            // Before the line: fine scrolling drops pixels.
            if (position === 0xef) {
                this.positionInLine = 0xf0;
            } else if ((position & 7) === (io[SCX] & 7)) {
                this.positionInLine = 0xf8;
            } else if (this.windowIsBeingFetched && (position & 7) === 6 && (io[SCX] & 7) === 7) {
                this.positionInLine = 0xf8;
            } else if (position === 0xf7) {
                this.positionInLine = 0xf0;
                return;
            } else {
                this.lineHasFractionalScrolling = true;
            }
        }
        this.windowIsBeingFetched = false;
        if (this.positionInLine >= 160) {
            this.positionInLine = (this.positionInLine + 1) & 0xff;
            return;
        }

        if (!(io[LCDC] & 1)) {
            if (cgb) bgPriority = 0;
            else pixel = 0;
        }
        if (pixel && bgPriority) drawObject = false;
        if (this.lcdX < 160 && this.currentLine < LINES) {
            let color;
            if (this.cgbPalettesPpuBlocked) {
                color = BLACK;
            } else if (drawObject) {
                if (!cgb) objectPixel = (io[objectPalette ? OBP1 : OBP0] >> (objectPixel << 1)) & 3;
                color = this.objRgb[objectPalette * 4 + objectPixel];
            } else {
                if (!cgb) pixel = (io[BGP] >> (pixel << 1)) & 3;
                color = this.bgRgb[bgPalette * 4 + pixel];
            }
            this.back[this.currentLine * SCREEN_WIDTH + this.lcdX] = color;
        }
        this.positionInLine = (this.positionInLine + 1) & 0xff;
        this.lcdX++;
    }

    /** The tile at map position `tileX`, row `y`: [attributes, low byte, high byte] (flipped). */
    #tileData(tileX, y, map) {
        const vram = this.vram;
        const index = map + (tileX & 0x1f) + (y >> 3) * 32;
        const tile = vram[index];
        const attributes = this.cgb ? vram[0x2000 + index] : 0;
        let address = this.gb.io[LCDC] & 0x10 ? tile * 16 : ((tile << 24) >> 24) * 16 + 0x1000;
        if (attributes & 8) address += 0x2000;
        address += ((y & 7) ^ (attributes & 0x40 ? 7 : 0)) * 2;
        let low = vram[address];
        let high = vram[address + 1];
        if (attributes & 0x20) {
            low = flip(low);
            high = flip(high);
        }
        this.tileAttributes = attributes;
        this.tileLow = low;
        this.tileHigh = high;
    }

    /** Draws a whole line in one go (render_line). */
    #renderLine() {
        const io = this.gb.io;
        const cgb = this.cgb;
        const line = this.currentLine;
        if (line >= LINES) return;
        const { vram, oam, back, bgRgb, objRgb } = this;
        const objPixel = this.lineObjPixel;
        const objPriority = this.lineObjPriority;
        const objPalette = this.lineObjPalette;
        const objBgPriority = this.lineObjBgPriority;

        let objects = false;
        if (this.nVisibleObjs && io[LCDC] & 2) {
            objects = true;
            objPixel.fill(0);
            while (this.nVisibleObjs) {
                const index = this.visibleObjs[this.nVisibleObjs - 1];
                const priority = this.objectPriority === Priority.X ? 0 : index;
                const y = oam[index * 4];
                const x = oam[index * 4 + 1];
                const tile = oam[index * 4 + 2];
                const flags = oam[index * 4 + 3];
                this.nVisibleObjs--;
                const address = this.#objectLineAddress(y, tile, flags);
                let low = vram[address];
                let high = vram[address + 1];
                if (this.nVisibleObjs === 0) this.dataForSelGlitch = high;
                if (flags & 0x20) {
                    low = flip(low);
                    high = flip(high);
                }
                if (x >= 168) continue;
                for (let i = 0; i < 8; i++) {
                    const pixel = ((low >> (7 - i)) & 1) | (((high >> (7 - i)) & 1) << 1);
                    const p = x + i;
                    if (pixel && (!objPixel[p] || priority < objPriority[p])) {
                        objPixel[p] = pixel;
                        objPriority[p] = priority;
                        objPalette[p] = cgb ? flags & 7 : (flags & 0x10) >> 4;
                        objBgPriority[p] = flags & 0x80;
                    }
                }
            }
        }

        const base = line * SCREEN_WIDTH;
        if (!cgb && !(io[LCDC] & 1)) {
            const bg = bgRgb[io[BGP] & 3];
            for (let s = 0; s < SCREEN_WIDTH; s++) {
                if (objects && objPixel[s + 8]) {
                    const palette = objPalette[s + 8];
                    const pixel = (io[OBP0 + palette] >> (objPixel[s + 8] << 1)) & 3;
                    back[base + s] = objRgb[pixel + palette * 4];
                } else {
                    back[base + s] = bg;
                }
            }
            return;
        }

        let pixels = 0;
        let tileX = io[SCX] >> 3;
        const fineScroll = io[SCX] & 7;
        let map = io[LCDC] & 0x08 ? 0x1c00 : 0x1800;
        let y = (line + io[SCY]) & 0xff;
        this.#tileData(tileX, y, map);
        let attributes = this.tileAttributes;
        let low = (this.tileLow << fineScroll) & 0xff;
        let high = (this.tileHigh << fineScroll) & 0xff;
        let checkWindow = this.wyTriggered && (io[LCDC] & 0x20) !== 0;
        let i = fineScroll;
        for (;;) {
            for (; i < 8 && pixels < SCREEN_WIDTH; i++) {
                if (checkWindow && io[WX] === pixels + 7) {
                    // The window starts: its first tile follows.
                    checkWindow = false;
                    map = io[LCDC] & 0x40 ? 0x1c00 : 0x1800;
                    tileX = 0xff;
                    this.windowY = (this.windowY + 1) & 0xff;
                    y = this.windowY;
                    break;
                }
                let pixel = (low >> 7) | ((high >> 7) << 1);
                low = (low << 1) & 0xff;
                high = (high << 1) & 0xff;
                const s = pixels + 8;
                if (objects && objPixel[s] &&
                    (pixel === 0 || !(objBgPriority[s] || attributes & 0x80) || !(io[LCDC] & 1))) {
                    let objectPixel = objPixel[s];
                    const palette = objPalette[s];
                    if (!cgb) objectPixel = (io[OBP0 + palette] >> (objectPixel << 1)) & 3;
                    back[base + pixels] = objRgb[objectPixel + (palette & 7) * 4];
                } else {
                    if (!cgb) pixel = (io[BGP] >> (pixel << 1)) & 3;
                    back[base + pixels] = bgRgb[pixel + (attributes & 7) * 4];
                }
                pixels++;
            }
            tileX = (tileX + 1) & 0xff;
            if (pixels >= SCREEN_WIDTH) break;
            if (pixels >= SCREEN_WIDTH - 8) this.fetcherState = (SCREEN_WIDTH - pixels) & 7;
            this.#tileData(tileX, y, map);
            attributes = this.tileAttributes;
            low = this.tileLow;
            high = this.tileHigh;
            i = 0;
        }
        this.#tileData(tileX, y, map);
        this.currentTileData[0] = this.tileLow;
        this.currentTileData[1] = this.tileHigh;
    }
}
