import { SCREEN_WIDTH } from "./constants.js";

// Fetcher steps; each VRAM read takes 2 dots (address, then data).
const GET_TILE_1 = 0;
const GET_TILE_2 = 1;
const DATA_LOW_1 = 2;
const DATA_LOW_2 = 3;
const DATA_HIGH_1 = 4;
const DATA_HIGH_2 = 5;
const PUSH = 6;

// Mode 3 registers the renderer replays: LCDC SCX SCY BGP OBP0 OBP1 WX.
export const LOGGED_REGISTERS = [0xff40, 0xff43, 0xff42, 0xff47, 0xff48, 0xff49, 0xff4b];
const LCDC = 0;
const SCX = 1;
const SCY = 2;
const BGP = 3;
const OBP0 = 4;
const OBP1 = 5;
const WX = 6;

// Dots from the start of mode 3 (as STAT shows it) to the first fetcher step.
const START_DELAY = 5;
// Offset between the dot a CPU write is logged at and the dot the PPU sees it.
export const WRITE_DELAY = -2;

/**
 * Dot-by-dot model of mode 3 (background fetcher, pixel FIFOs, sprite
 * fetches, window activation), used for lines where the game changes PPU
 * registers while the line is being drawn. The other lines take the fast
 * path in ppu.js; both produce the same picture when nothing changes.
 *
 * Adapted from SameBoy's display.c (MIT, Lior Halphon), which in turn
 * follows Matt Currie's Mealybug Tearoom research.
 */
export class PixelFifo {
    constructor(cgb) {
        this.cgb = cgb;
        this.regs = new Uint8Array(7);
        // Writes logged during mode 3: dot, register index, value.
        this.logDots = new Int32Array(64);
        this.logRegs = new Uint8Array(64);
        this.logValues = new Uint8Array(64);
        this.logLength = 0;
        this.logNext = 0;

        this.bgPixel = new Uint8Array(8);
        this.bgPalette = new Uint8Array(8);
        this.bgPriority = new Uint8Array(8);
        this.objPixel = new Uint8Array(8);
        this.objPalette = new Uint8Array(8);
        this.objPriority = new Uint8Array(8);
        this.objBehind = new Uint8Array(8);
        this.objIndex = new Uint8Array(10);
        this.objX = new Uint8Array(10);
        this.objY = new Uint8Array(10);
    }

    /**
     * Records a register write during mode 3 (`dot` = dot within the line;
     * `old` = the register's previous value).
     */
    log(dot, register, value, old) {
        const index = LOGGED_REGISTERS.indexOf(register);
        if (index < 0 || this.logLength > this.logDots.length - 2) return;
        if (index >= BGP && index <= OBP1 && !this.cgb) {
            // DMG: for one dot the PPU sees the old and new palette ORed together.
            this.#append(dot, index, old | value);
            dot++;
        } else if (index === LCDC && (old ^ value) & 1) {
            // The BG enable bit reaches the pixel output a dot after the fetcher sees the rest.
            this.#append(dot, index, (value & ~1) | (old & 1));
            dot++;
        }
        this.#append(dot, index, value);
    }

    #append(dot, index, value) {
        this.logDots[this.logLength] = dot;
        this.logRegs[this.logLength] = index;
        this.logValues[this.logLength] = value;
        this.logLength++;
    }

    /**
     * Renders line `ppu.ly` into the back buffer. `start` holds the register
     * values at the start of mode 3 (in LOGGED_REGISTERS order); `drawStart`
     * is the line dot at which mode 3 started.
     */
    render(ppu, start, drawStart) {
        const regs = this.regs;
        regs.set(start);
        this.logNext = 0;
        this.time = drawStart + START_DELAY - WRITE_DELAY;
        this.#applyWrites();

        const { cgb, vram, oam } = ppu;
        this.ppu = ppu;
        this.base = ppu.ly * SCREEN_WIDTH;
        this.pos = -16;
        this.lcdX = 0;
        this.bgRead = 0;
        this.bgSize = 8; // 8 junk pixels, dropped while scrolling into the line
        this.bgPixel.fill(0);
        this.bgPalette.fill(0);
        this.bgPriority.fill(0);
        this.objRead = 0;
        this.objSize = 0;
        this.fetcher = GET_TILE_1;
        this.tile = 0;
        this.attr = 0;
        this.data0 = 0;
        this.data1 = 0;
        this.address = 0;
        this.wxTriggered = false;
        this.windowTileX = 0;
        this.windowY = ppu.windowLine - 1;
        this.windowFetching = false;
        this.insertBgPixel = false;
        this.duringObjectFetch = false;
        this.fractionalScroll = false;

        // Visible sprites sorted by X, descending, so the next to fetch is last.
        // Among equal X, lower OAM indices come last (fetched first).
        let count = 0;
        for (let i = 0; i < ppu.spriteCount; i++) {
            const index = ppu.lineSprites[i];
            const x = oam[index * 4 + 1];
            let j = 0;
            while (j < count && this.objX[j] > x) j++;
            this.objIndex.copyWithin(j + 1, j, count);
            this.objX.copyWithin(j + 1, j, count);
            this.objY.copyWithin(j + 1, j, count);
            this.objIndex[j] = index;
            this.objX[j] = x;
            this.objY[j] = oam[index * 4];
            count++;
        }
        this.objCount = count;

        for (;;) {
            this.#window();

            // Sprites: drop the ones already passed, fetch the ones starting here.
            while (this.objCount && this.objX[this.objCount - 1] < this.#objectMatchX()) this.objCount--;
            this.duringObjectFetch = true;
            while (this.objCount && (regs[LCDC] & 2 || cgb) && this.objX[this.objCount - 1] === this.#objectMatchX()) {
                while (this.fetcher < DATA_HIGH_2 || this.bgSize === 0) {
                    this.#fetch(vram);
                    this.#tick(1);
                }
                this.#fetch(vram);
                this.#tick(1);
                this.#fetch(vram);
                this.#fetchObject(vram, oam);
            }
            this.duringObjectFetch = false;

            this.#renderPixel();
            this.#fetch(vram);
            if (this.pos === 160) break;
            this.#tick(1);
        }

        // The LCD fell behind the PPU (window glitch): repeat the last color.
        const back = ppu.back;
        while (this.lcdX < SCREEN_WIDTH) {
            back[this.base + this.lcdX] = this.lcdX ? back[this.base + this.lcdX - 1] : back[this.base];
            this.lcdX++;
        }
        ppu.windowLine = this.windowY + 1;
        this.logLength = 0;
    }

    #tick(dots) {
        this.time += dots;
        this.#applyWrites();
    }

    #applyWrites() {
        while (this.logNext < this.logLength && this.logDots[this.logNext] <= this.time) {
            this.regs[this.logRegs[this.logNext]] = this.logValues[this.logNext];
            this.logNext++;
        }
    }

    #objectMatchX() {
        const x = (this.pos + 8) & 0xff;
        return x > 240 ? 0 : x;
    }

    #window() {
        const regs = this.regs;
        const ppu = this.ppu;
        if (this.wxTriggered || !ppu.windowTriggered || !(regs[LCDC] & 0x20)) return;
        const wx = regs[WX];
        const pos = this.pos;
        let activate = false;
        if (wx === 0) {
            activate = pos === -7 || (pos === -16 && (regs[SCX] & 7) !== 0) || (pos >= -15 && pos <= -8);
        } else if (wx < 166 + (this.cgb ? 1 : 0)) {
            if (wx === ((pos + 7) & 0xff)) {
                activate = true;
            } else if (!this.cgb && wx === ((pos + 6) & 0xff)) {
                // The DMG's LCD falls a pixel behind the PPU.
                activate = true;
                if (this.lcdX > 0) this.lcdX--;
            }
        }
        if (activate) {
            this.windowY++;
            this.windowTileX = 0;
            this.bgSize = 0;
            if (wx === 0 && regs[SCX] & 7 && !this.cgb) this.#tick(1);
            this.wxTriggered = true;
            this.fetcher = GET_TILE_1;
            this.windowFetching = true;
        } else if (!this.cgb && wx === 166 && wx === ((pos + 7) & 0xff)) {
            this.windowY++;
        }
        if (wx === ((pos + 7) & 0xff) && (!this.cgb || wx === 0) && this.wxTriggered && !this.windowFetching &&
            this.fetcher === GET_TILE_1 && this.bgSize === 8) {
            this.insertBgPixel = true;
        }
    }

    #fetcherY() {
        return this.wxTriggered ? this.windowY & 0xff : (this.ppu.ly + this.regs[SCY]) & 0xff;
    }

    #tileDataAddress() {
        const y = this.#fetcherY();
        let address = this.regs[LCDC] & 0x10 ? this.tile * 16 : 0x1000 + ((this.tile << 24) >> 24) * 16;
        if (this.attr & 0x08) address += 0x2000;
        return address + ((y & 7) ^ (this.attr & 0x40 ? 7 : 0)) * 2;
    }

    /** One dot of the background fetcher. */
    #fetch(vram) {
        const regs = this.regs;
        switch (this.fetcher) {
            case GET_TILE_1: {
                if (!(regs[LCDC] & 0x20)) this.wxTriggered = false;
                const map = (this.wxTriggered ? regs[LCDC] & 0x40 : regs[LCDC] & 0x08) ? 0x1c00 : 0x1800;
                const y = this.#fetcherY();
                let x;
                if (this.wxTriggered) x = this.windowTileX;
                else if (this.pos < -8) x = regs[SCX] >> 3;
                else x = ((regs[SCX] + this.pos + 8 - (this.cgb && !this.duringObjectFetch ? 1 : 0)) >> 3) & 31;
                this.address = map + x + (y >> 3) * 32;
                this.fetcher++;
                return;
            }
            case GET_TILE_2:
                this.tile = vram[this.address];
                this.attr = this.cgb ? vram[this.address + 0x2000] : 0;
                this.fetcher++;
                return;
            case DATA_LOW_1:
                this.address = this.#tileDataAddress();
                this.fetcher++;
                return;
            case DATA_LOW_2:
                this.data0 = vram[this.address];
                this.fetcher++;
                return;
            case DATA_HIGH_1:
                this.address = this.#tileDataAddress() + 1;
                this.fetcher++;
                return;
            case DATA_HIGH_2:
                this.data1 = vram[this.address];
                if (this.wxTriggered) this.windowTileX = (this.windowTileX + 1) & 31;
            // falls through
            default: {
                this.fetcher = PUSH;
                if (this.bgSize > 0) return;
                const ppu = this.ppu;
                if (!this.cgb && ppu.windowTriggered && !(regs[LCDC] & 0x20)) {
                    // DMG: with the window just disabled, WX matching inserts one blank pixel.
                    let position = (this.pos + 7) & 0xff;
                    if (position > 167) position = 0;
                    if (regs[WX] === position) {
                        this.bgRead = 0;
                        this.bgPixel[0] = 0;
                        this.bgPalette[0] = 0;
                        this.bgPriority[0] = 0;
                        this.bgSize = 1;
                        return;
                    }
                }
                let low = this.data0;
                let high = this.data1;
                const flip = this.attr & 0x20;
                for (let i = 0; i < 8; i++) {
                    const bit = flip ? i : 7 - i;
                    this.bgPixel[i] = ((low >> bit) & 1) | (((high >> bit) & 1) << 1);
                    this.bgPalette[i] = this.attr & 7;
                    this.bgPriority[i] = this.attr & 0x80 ? 1 : 0;
                }
                this.bgRead = 0;
                this.bgSize = 8;
                this.fetcher = GET_TILE_1;
            }
        }
    }

    #fetchObject(vram, oam) {
        const i = this.objCount - 1;
        const index = this.objIndex[i];
        const tile = oam[index * 4 + 2];
        const flags = oam[index * 4 + 3];
        this.#tick(2);
        const low = vram[this.#objectRowAddress(tile, flags, i)];
        this.#tick(2);
        this.duringObjectFetch = false;
        const high = vram[this.#objectRowAddress(tile, flags, i) + 1];
        this.#tick(1);

        // Overlay onto the object FIFO; on the CGB lower OAM indices win.
        while (this.objSize < 8) {
            const slot = (this.objRead + this.objSize) & 7;
            this.objPixel[slot] = 0;
            this.objSize++;
        }
        const palette = this.cgb ? flags & 7 : (flags >> 4) & 1;
        const priority = this.cgb && !this.ppu.opri ? index : 0;
        const flip = flags & 0x20;
        for (let p = 0; p < 8; p++) {
            const bit = flip ? p : 7 - p;
            const pixel = ((low >> bit) & 1) | (((high >> bit) & 1) << 1);
            const slot = (this.objRead + p) & 7;
            if (pixel && (!this.objPixel[slot] || this.objPriority[slot] > priority)) {
                this.objPixel[slot] = pixel;
                this.objPalette[slot] = palette;
                this.objBehind[slot] = flags & 0x80 ? 1 : 0;
                this.objPriority[slot] = priority;
            }
        }
        this.objCount--;
    }

    /** The sprite size is read at each tile data fetch, so changing it mid-fetch mixes rows. */
    #objectRowAddress(tile, flags, i) {
        const tall = (this.regs[LCDC] & 4) !== 0;
        let row = (this.ppu.ly - (this.objY[i] - 16)) & (tall ? 15 : 7);
        if (flags & 0x40) row ^= tall ? 15 : 7;
        const address = (tall ? tile & 0xfe : tile) * 16 + row * 2;
        return this.cgb && flags & 0x08 ? address + 0x2000 : address;
    }

    #renderPixel() {
        const regs = this.regs;
        const cgb = this.cgb;
        // Nothing is drawn while a sprite at X=0 is pending.
        if (this.objCount && (regs[LCDC] & 2 || cgb) && this.objX[this.objCount - 1] === 0) return;
        if (!this.bgSize) return;

        let bgPixel = 0;
        let bgPalette = 0;
        let priority = 0;
        if (this.insertBgPixel) {
            this.insertBgPixel = false;
        } else {
            const r = this.bgRead;
            bgPixel = this.bgPixel[r];
            bgPalette = this.bgPalette[r];
            priority = this.bgPriority[r];
            this.bgRead = (r + 1) & 7;
            this.bgSize--;
        }

        let objPixel = 0;
        let objPalette = 0;
        if (this.objSize) {
            const r = this.objRead;
            if (this.objPixel[r] && regs[LCDC] & 2) {
                objPixel = this.objPixel[r];
                objPalette = this.objPalette[r];
                priority |= this.objBehind[r];
            }
            this.objRead = (r + 1) & 7;
            this.objSize--;
        }

        // Fine scrolling: drop pixels until the line's first visible one.
        if (this.pos < -8) {
            if (this.pos === -17) this.pos = -16;
            else if ((this.pos & 7) === (regs[SCX] & 7)) this.pos = -8;
            else if (this.windowFetching && (this.pos & 7) === 6 && (regs[SCX] & 7) === 7) this.pos = -8;
            else if (this.pos === -9) {
                this.pos = -16;
                return;
            } else {
                this.fractionalScroll = true;
            }
        }
        this.windowFetching = false;

        if (this.pos >= 160 || this.pos < 0) {
            this.pos++;
            return;
        }

        if (!(regs[LCDC] & 1)) {
            if (cgb) priority = 0;
            else bgPixel = 0;
        }
        if (bgPixel && priority) objPixel = 0;

        const ppu = this.ppu;
        let color;
        if (objPixel) {
            color = cgb ? ppu.objColors[objPalette * 4 + objPixel]
                : (objPalette ? ppu.dmgObj1 : ppu.dmgObj0)[(regs[objPalette ? OBP1 : OBP0] >> (objPixel * 2)) & 3];
        } else {
            color = cgb ? ppu.bgColors[bgPalette * 4 + bgPixel] : ppu.dmgBg[(regs[BGP] >> (bgPixel * 2)) & 3];
        }
        if (this.lcdX < SCREEN_WIDTH) ppu.back[this.base + this.lcdX] = color;
        this.pos++;
        this.lcdX++;
    }
}
