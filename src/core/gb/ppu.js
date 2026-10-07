import { Interrupt, SCREEN_HEIGHT, SCREEN_WIDTH } from './constants.js';
import { LOGGED_REGISTERS, PixelFifo } from './fifo.js';
import { cgbToPixel, DEFAULT_DMG_PALETTE, rgbToPixel } from './palettes.js';

const LINE_DOTS = 456;
const MAX_SPRITES_PER_LINE = 10;
const WHITE = 0xffffffff;

/** OAM bug write corruption of a row's first word. */
function glitchWrite(a, b, c) {
  return ((a ^ c) & (b ^ c)) ^ c;
}

// Events within a line, in order. Dots count from the start of the line,
// when LY changes and the OAM-scan interrupt fires; STAT shows the new mode
// and the LY=LYC flag 4 dots later.
const Phase = {
  OAM_SCAN: 0, // dot 4: STAT mode 2, LY=LYC compare
  VRAM_LOCK: 1, // dot 80: VRAM reads blocked; OAM writes briefly allowed
  DRAWING: 2, // dot 84: mode 3
  HBLANK_IRQ: 3, // 4 dots before the end of mode 3: HBlank interrupt
  HBLANK: 4, // mode 0, VRAM and OAM accessible; line rendered, HDMA
  LINE_END: 5, // dot 456
  VBLANK_LYC: 6, // dot 4 of lines 144-153
  LY_RESET: 7, // line 153, dot 8: LY reads 0 from dot 4, the LY=LYC flag drops
  LY_RESET_LYC: 8, // line 153, dot 12: compares LY=0
  VBLANK_END: 9, // dot 456 of lines 144-153
  VBLANK_START: 10, // line 144, dot 4: VBlank interrupt, mode 1
  FIFO_RENDER: 11, // 8 dots into HBlank, for lines drawn by PixelFifo
};

/**
 * Picture processing unit, DMG and CGB.
 *
 * Mode timing (OAM scan, drawing, HBlank, VBlank), STAT interrupts and the
 * CPU's VRAM/OAM access windows are emulated to the M-cycle; each line is
 * rendered in one go when drawing ends, which handles mid-frame effects done
 * between lines (the vast majority) but not register writes in the middle of
 * a line.
 *
 * Frames are rendered into a back buffer and swapped in at VBlank, so the
 * front buffer always holds a complete frame.
 */
export class Ppu {
  #oamWords;

  /** @param {import('./gameboy.js').GameBoy} gb */
  constructor(gb) {
    this.gb = gb;
    this.cgb = gb.cgb;
    this.vram = new Uint8Array(this.cgb ? 0x4000 : 0x2000);
    this.oam = new Uint8Array(0xa0);
    // OAM as 16-bit words (little-endian hosts), for the OAM bug.
    this.#oamWords = new Uint16Array(this.oam.buffer);
    this.bgPaletteRam = new Uint8Array(64);
    this.objPaletteRam = new Uint8Array(64);
    this.bgColors = new Uint32Array(32);
    this.objColors = new Uint32Array(32);
    // DMG mode: the colors BGP, OBP0 and OBP1 pick from (one set on a DMG,
    // three when a Game Boy Color colors an old game).
    this.dmgBg = new Uint32Array(DEFAULT_DMG_PALETTE.map(rgbToPixel));
    this.dmgObj0 = this.dmgBg.slice();
    this.dmgObj1 = this.dmgBg.slice();
    // CGB colors mixed to look like the Game Boy Color's LCD.
    this.colorCorrection = false;
    this.bgShades = new Uint32Array(4);
    this.obp0Shades = new Uint32Array(4);
    this.obp1Shades = new Uint32Array(4);

    this.front = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.back = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.frontBytes = new Uint8ClampedArray(this.front.buffer);
    this.backBytes = new Uint8ClampedArray(this.back.buffer);

    // Per-line scratch: BG color index and CGB priority attribute per pixel,
    // pixels already taken by a higher-priority sprite, sprites on the line.
    this.lineIndex = new Uint8Array(SCREEN_WIDTH);
    this.linePriority = new Uint8Array(SCREEN_WIDTH);
    this.lineTaken = new Uint8Array(SCREEN_WIDTH);
    this.lineSprites = new Uint8Array(MAX_SPRITES_PER_LINE);
    // Lines with register writes during mode 3 are drawn dot by dot instead.
    this.fifo = new PixelFifo(this.cgb);
    this.drawStartRegs = new Uint8Array(LOGGED_REGISTERS.length);
    this.reset();
  }

  reset() {
    this.vram.fill(0);
    this.oam.fill(0);
    this.bgPaletteRam.fill(0xff);
    this.objPaletteRam.fill(0xff);
    this.vramBank = 0;
    this.lcdc = 0;
    this.statEnables = 0;
    this.scy = 0;
    this.scx = 0;
    this.ly = 0;
    this.lyc = 0;
    this.bgp = 0xfc;
    this.obp0 = 0xff;
    this.obp1 = 0xff;
    this.wy = 0;
    this.wx = 0;
    this.bcps = 0;
    this.ocps = 0;
    // Object priority: CGB games order sprites by OAM index (0), DMG by X (1).
    this.opri = this.cgb ? 0 : 1;

    // Mode as STAT reads it, and as the interrupt sources see it (it changes earlier).
    this.mode = 0;
    this.irqMode = 0;
    this.phase = Phase.LINE_END;
    this.dot = 0;
    this.nextEvent = LINE_DOTS;
    // CPU access to OAM and VRAM; reads and writes are blocked at slightly different times.
    this.oamReadBlocked = false;
    this.oamWriteBlocked = false;
    this.vramReadBlocked = false;
    this.vramWriteBlocked = false;
    this.windowLine = 0;
    this.windowTriggered = false;
    this.coincidence = false;
    this.statSignal = false;
    this.spriteCount = 0;
    // In OAM scan, the PPU reads one OAM row per M-cycle (see oamBugRow()).
    this.oamScan = false;
    this.drawing = false;
    this.fifo.logLength = 0;
    this.frameDone = false;
    // The first frame after switching the LCD on isn't shown.
    this.skipFrame = false;
    this.#refreshColors();
    this.front.fill(this.#blank());
    this.back.fill(this.#blank());
  }

  sync(s) {
    s.bytes(this.vram);
    s.bytes(this.oam);
    s.bytes(this.bgPaletteRam);
    s.bytes(this.objPaletteRam);
    for (const r of ['vramBank', 'lcdc', 'statEnables', 'scy', 'scx', 'ly', 'lyc', 'bgp', 'obp0', 'obp1', 'wy', 'wx',
      'bcps', 'ocps', 'opri', 'mode', 'irqMode', 'phase', 'windowLine', 'spriteCount']) {
      this[r] = s.u8(this[r]);
    }
    this.dot = s.u16(this.dot);
    this.nextEvent = s.u16(this.nextEvent);
    for (const flag of ['oamReadBlocked', 'oamWriteBlocked', 'vramReadBlocked', 'vramWriteBlocked', 'windowTriggered',
      'coincidence', 'statSignal', 'frameDone', 'skipFrame', 'drawing', 'oamScan']) {
      this[flag] = s.bool(this[flag]);
    }
    s.bytes(this.lineSprites);
    s.bytes(this.drawStartRegs);
    const { fifo } = this;
    fifo.logLength = s.u8(fifo.logLength);
    s.bytes(fifo.logDots);
    s.bytes(fifo.logRegs);
    s.bytes(fifo.logValues);
    s.bytes(this.front);
    if (s.reading) this.#refreshColors();
  }

  /** Sets the four DMG shades, lightest first, as 0xRRGGBB. */
  setDmgPalette(colors) {
    const pixels = colors.map(rgbToPixel);
    this.dmgBg.set(pixels);
    this.dmgObj0.set(pixels);
    this.dmgObj1.set(pixels);
    this.#refreshColors();
  }

  /** Colors a DMG game like a Game Boy Color: separate 15-bit palettes for BG and sprites. */
  setCompatPalette({ bg, obj0, obj1 }) {
    const pixel = (color) => cgbToPixel(color, this.colorCorrection);
    this.dmgBg.set(bg.map(pixel));
    this.dmgObj0.set(obj0.map(pixel));
    this.dmgObj1.set(obj1.map(pixel));
    this.#refreshColors();
  }

  setColorCorrection(enabled) {
    this.colorCorrection = enabled;
    this.#refreshColors();
  }

  get enabled() {
    return (this.lcdc & 0x80) !== 0;
  }

  /** Advances by `dots` (T-cycles at normal speed). */
  tick(dots) {
    if (!(this.lcdc & 0x80)) return;
    this.dot += dots;
    while (this.dot >= this.nextEvent) this.#advance();
  }

  #advance() {
    switch (this.phase) {
      case Phase.OAM_SCAN:
        this.mode = 2;
        this.irqMode = 2;
        this.oamWriteBlocked = true;
        this.#checkWindowY();
        this.#compareLy();
        this.#next(Phase.VRAM_LOCK, 80);
        break;
      case Phase.VRAM_LOCK:
        this.vramReadBlocked = true;
        this.oamWriteBlocked = false;
        this.#next(Phase.DRAWING, 84);
        break;
      case Phase.DRAWING:
        this.oamScan = false;
        this.#scanOam();
        this.drawing = true;
        this.fifo.logLength = 0;
        for (let i = 0; i < LOGGED_REGISTERS.length; i++) this.drawStartRegs[i] = this.readRegister(LOGGED_REGISTERS[i]);
        this.mode = 3;
        this.irqMode = 3;
        this.#blockAccess(true);
        this.#updateStat();
        this.#next(Phase.HBLANK_IRQ, 84 + this.#drawingDots() - 4);
        break;
      case Phase.HBLANK_IRQ:
        this.irqMode = 0;
        this.#updateStat();
        this.#next(Phase.HBLANK, this.nextEvent + 4);
        break;
      case Phase.HBLANK:
        this.mode = 0;
        this.#blockAccess(false);
        if (this.fifo.logLength) {
          // Registers changed while drawing: the dot-by-dot renderer runs a
          // little later, so writes landing on the last pixels are included.
          this.gb.hblank();
          this.#next(Phase.FIFO_RENDER, this.nextEvent + 8);
          break;
        }
        this.drawing = false;
        this.#renderLine();
        this.gb.hblank();
        this.#nextAfterRender();
        break;
      case Phase.FIFO_RENDER:
        this.drawing = false;
        this.fifo.render(this, this.drawStartRegs, 84);
        this.#nextAfterRender();
        break;
      case Phase.LINE_END:
        this.dot -= LINE_DOTS;
        this.ly++;
        this.coincidence = false;
        if (this.ly === SCREEN_HEIGHT) {
          // The OAM-scan STAT source also fires as line 144 starts; on the
          // CGB 4 dots before the VBlank interrupt, on the DMG with it.
          this.#updateStat(this.cgb ? this.statEnables & 0x20 : 0);
          this.#next(Phase.VBLANK_START, 4);
        } else {
          this.irqMode = 2;
          this.oamReadBlocked = true;
          this.oamScan = !this.cgb;
          this.#updateStat();
          this.#next(Phase.OAM_SCAN, 4);
        }
        break;
      case Phase.VBLANK_START:
        this.#startVBlank();
      // falls through
      case Phase.VBLANK_LYC:
        this.#compareLy();
        if (this.ly === 153) {
          this.ly = 0;
          this.#next(Phase.LY_RESET, 8);
        } else {
          this.#next(Phase.VBLANK_END, LINE_DOTS);
        }
        break;
      case Phase.LY_RESET:
        this.coincidence = false;
        this.#updateStat();
        this.#next(Phase.LY_RESET_LYC, 12);
        break;
      case Phase.LY_RESET_LYC:
        this.#compareLy();
        this.#next(Phase.VBLANK_END, LINE_DOTS);
        break;
      default: // VBLANK_END
        this.dot -= LINE_DOTS;
        if (this.ly === 0) {
          // Line 153 is over: new frame. On line 0 the OAM-scan interrupt
          // comes with the STAT change, not before it.
          this.windowLine = 0;
          this.windowTriggered = false;
          this.oamReadBlocked = true;
          this.oamScan = !this.cgb;
          this.#next(Phase.OAM_SCAN, 4);
        } else {
          this.ly++;
          this.coincidence = false;
          this.#updateStat();
          this.#next(Phase.VBLANK_LYC, 4);
        }
    }
  }

  #nextAfterRender() {
    this.#next(Phase.LINE_END, LINE_DOTS);
  }

  #blockAccess(blocked) {
    this.oamReadBlocked = blocked;
    this.oamWriteBlocked = blocked;
    this.vramReadBlocked = blocked;
    this.vramWriteBlocked = blocked;
  }

  #next(phase, dot) {
    this.phase = phase;
    this.nextEvent = dot;
  }

  #startVBlank() {
    this.mode = 1;
    this.irqMode = 1;
    this.#blockAccess(false);
    this.frameDone = true;
    this.gb.if |= Interrupt.VBLANK;
    if (this.skipFrame) {
      this.skipFrame = false;
    } else {
      [this.front, this.back] = [this.back, this.front];
      [this.frontBytes, this.backBytes] = [this.backBytes, this.frontBytes];
    }
    this.#updateStat(this.cgb ? 0 : this.statEnables & 0x20);
  }

  /** The window can only start on a frame once LY has matched WY while it was enabled. */
  #checkWindowY() {
    if (this.lcdc & 0x20 && this.ly === this.wy) this.windowTriggered = true;
  }

  #compareLy() {
    this.coincidence = this.ly === this.lyc;
    this.#updateStat();
  }

  /** STAT interrupts fire on rising edges of the OR of the enabled sources. */
  #updateStat(extra = 0) {
    if (!(this.lcdc & 0x80)) return;
    const s = this.statEnables;
    const mode = this.irqMode;
    const line = extra !== 0 || (s & 0x40 && this.coincidence) || (s & 0x08 && mode === 0) ||
      (s & 0x10 && mode === 1) || (s & 0x20 && mode === 2);
    if (line && !this.statSignal) this.gb.if |= Interrupt.STAT;
    this.statSignal = !!line;
  }

  /** Length of mode 3: longer with fine scrolling, the window and sprites. */
  #drawingDots() {
    let dots = 172 + (this.scx & 7);
    if (this.#windowOnLine()) dots += 6;
    if (!(this.lcdc & 2)) return dots;
    // Each sprite costs 6 dots, plus a wait for the background fetch of the
    // first sprite in each tile: the tile's pixels right of the sprite, minus 2.
    let penalty = 0;
    let tiles = 0;
    for (let i = 0; i < this.spriteCount; i++) {
      const x = this.oam[this.lineSprites[i] * 4 + 1];
      if (x >= 168) continue;
      const pos = x + (this.scx & 7);
      if (!(tiles & (1 << (pos >> 3)))) {
        tiles |= 1 << (pos >> 3);
        penalty += Math.max(0, 5 - (pos & 7));
      }
      penalty += 6;
    }
    // Measured on hardware (Mooneye's intr_2_mode0_timing_sprites), mode 3
    // then ends 3 dots earlier than the plain sum suggests.
    return penalty ? dots + penalty - 3 : dots;
  }

  #windowOnLine() {
    return (this.lcdc & 0x20) !== 0 && this.windowTriggered && this.wx <= 166 && (this.cgb || (this.lcdc & 1) !== 0);
  }

  #scanOam() {
    const height = this.lcdc & 4 ? 16 : 8;
    const ly = this.ly;
    let count = 0;
    for (let i = 0; i < 40 && count < MAX_SPRITES_PER_LINE; i++) {
      const y = this.oam[i * 4] - 16;
      if (ly >= y && ly < y + height) this.lineSprites[count++] = i;
    }
    this.spriteCount = count;
  }

  // --- Rendering ---------------------------------------------------------------

  #renderLine() {
    const { lcdc, back } = this;
    const base = this.ly * SCREEN_WIDTH;

    if (this.cgb || lcdc & 1) {
      const window = this.#windowOnLine();
      const windowX = window ? Math.max(this.wx - 7, 0) : SCREEN_WIDTH;
      if (windowX > 0) {
        this.#renderTiles(lcdc & 0x08 ? 0x1c00 : 0x1800, this.scx, (this.ly + this.scy) & 0xff, 0, windowX, base);
      }
      if (window) {
        this.#renderTiles(lcdc & 0x40 ? 0x1c00 : 0x1800, windowX - (this.wx - 7), this.windowLine, windowX, SCREEN_WIDTH, base);
        this.windowLine++;
      }
    } else {
      // DMG with BG and window off: color 0.
      back.fill(this.bgShades[0], base, base + SCREEN_WIDTH);
      this.lineIndex.fill(0);
    }

    if (lcdc & 2 && this.spriteCount) this.#renderSprites(base);
  }

  /** Draws BG or window tiles to screen pixels [x0, x1), starting at map position (srcX, srcY). */
  #renderTiles(mapBase, srcX, srcY, x0, x1, base) {
    const { vram, back, cgb, lineIndex, linePriority } = this;
    const unsignedTiles = this.lcdc & 0x10;
    const rowBase = mapBase + ((srcY >> 3) & 31) * 32;
    const fineY = srcY & 7;
    const colors = cgb ? this.bgColors : this.bgShades;
    let x = x0;
    let tx = srcX;
    while (x < x1) {
      const mapAddr = rowBase + ((tx >> 3) & 31);
      const tile = vram[mapAddr];
      const attr = cgb ? vram[0x2000 + mapAddr] : 0;
      let addr = unsignedTiles ? tile * 16 : 0x1000 + ((tile << 24) >> 24) * 16;
      if (attr & 0x08) addr += 0x2000;
      addr += (attr & 0x40 ? 7 - fineY : fineY) * 2;
      const low = vram[addr];
      const high = vram[addr + 1];
      const flip = attr & 0x20;
      const palette = (attr & 7) * 4;
      const priority = attr & 0x80;
      for (let px = tx & 7; px < 8 && x < x1; px++, x++, tx++) {
        const bit = flip ? px : 7 - px;
        const index = (((high >> bit) & 1) << 1) | ((low >> bit) & 1);
        lineIndex[x] = index;
        linePriority[x] = priority;
        back[base + x] = colors[palette + index];
      }
    }
  }

  #renderSprites(base) {
    const { oam, vram, back, cgb, lineIndex, linePriority, lineTaken, lineSprites } = this;
    const count = this.spriteCount;
    const height = this.lcdc & 4 ? 16 : 8;
    // CGB: LCDC bit 0 off puts sprites above the background regardless of priority.
    const bgPriority = !cgb || (this.lcdc & 1) !== 0;

    // Highest priority first: lower OAM index, or on DMG lower X (stable for ties).
    if (this.opri) {
      for (let i = 1; i < count; i++) {
        const sprite = lineSprites[i];
        const x = oam[sprite * 4 + 1];
        let j = i - 1;
        while (j >= 0 && oam[lineSprites[j] * 4 + 1] > x) {
          lineSprites[j + 1] = lineSprites[j];
          j--;
        }
        lineSprites[j + 1] = sprite;
      }
    }

    lineTaken.fill(0);
    for (let i = 0; i < count; i++) {
      const o = lineSprites[i] * 4;
      const x = oam[o + 1] - 8;
      if (x <= -8 || x >= SCREEN_WIDTH) continue;
      const attr = oam[o + 3];
      let row = this.ly - (oam[o] - 16);
      if (attr & 0x40) row = height - 1 - row;
      const tile = height === 16 ? oam[o + 2] & 0xfe : oam[o + 2];
      let addr = tile * 16 + row * 2;
      if (cgb && attr & 0x08) addr += 0x2000;
      const low = vram[addr];
      const high = vram[addr + 1];
      const flip = attr & 0x20;
      const behind = attr & 0x80;
      const colors = cgb ? this.objColors : attr & 0x10 ? this.obp1Shades : this.obp0Shades;
      const palette = cgb ? (attr & 7) * 4 : 0;
      for (let px = 0; px < 8; px++) {
        const sx = x + px;
        if (sx < 0 || sx >= SCREEN_WIDTH || lineTaken[sx]) continue;
        const bit = flip ? px : 7 - px;
        const index = (((high >> bit) & 1) << 1) | ((low >> bit) & 1);
        if (!index) continue;
        // A higher-priority sprite hides lower ones even where the background covers it.
        lineTaken[sx] = 1;
        if (bgPriority && lineIndex[sx] && (behind || linePriority[sx])) continue;
        back[base + sx] = colors[palette + index];
      }
    }
  }

  #blank() {
    return this.cgb ? WHITE : this.dmgBg[0];
  }

  #refreshColors() {
    for (let i = 0; i < 4; i++) {
      this.bgShades[i] = this.dmgBg[(this.bgp >> (i * 2)) & 3];
      this.obp0Shades[i] = this.dmgObj0[(this.obp0 >> (i * 2)) & 3];
      this.obp1Shades[i] = this.dmgObj1[(this.obp1 >> (i * 2)) & 3];
    }
    for (let i = 0; i < 32; i++) {
      this.bgColors[i] = cgbToPixel(this.bgPaletteRam[i * 2] | (this.bgPaletteRam[i * 2 + 1] << 8), this.colorCorrection);
      this.objColors[i] = cgbToPixel(this.objPaletteRam[i * 2] | (this.objPaletteRam[i * 2 + 1] << 8), this.colorCorrection);
    }
  }

  // --- CPU access ----------------------------------------------------------------

  readVram(addr) {
    if (this.vramReadBlocked) return 0xff;
    return this.vram[(this.vramBank << 13) | (addr & 0x1fff)];
  }

  writeVram(addr, value) {
    if (this.vramWriteBlocked) return;
    this.vram[(this.vramBank << 13) | (addr & 0x1fff)] = value;
  }

  readOam(addr) {
    return this.oamReadBlocked ? 0xff : this.oam[addr - 0xfe00];
  }

  writeOam(addr, value) {
    if (!this.oamWriteBlocked) this.oam[addr - 0xfe00] = value;
  }

  /**
   * DMG OAM bug: the OAM row (byte offset) the scan reads in this M-cycle,
   * or -1. Rows 1-19 can be corrupted; the scan reads one every 4 dots.
   */
  oamBugRow() {
    if (!this.oamScan) return -1;
    const row = this.dot >> 2;
    return row >= 1 && row < 20 ? row * 8 : -1;
  }

  /** CPU write (or 16-bit increment) on OAM's address range during OAM scan. */
  oamBugWrite() {
    const r = this.oamBugRow();
    if (r < 0) return;
    const w = this.#oamWords;
    w[r >> 1] = glitchWrite(w[r >> 1], w[(r - 8) >> 1], w[(r - 4) >> 1]);
    this.oam.copyWithin(r + 2, r - 6, r);
  }

  /**
   * CPU read on OAM's address range during OAM scan. The patterns depend on
   * the row; these are a DMG-B's (from SameBoy).
   */
  oamBugRead() {
    const r = this.oamBugRow();
    if (r < 0) return;
    const oam = this.oam;
    const w = this.#oamWords;
    const at = (offset) => w[(r + offset) >> 1];
    if ((r & 0x18) === 0x10) {
      w[(r - 8) >> 1] = (at(-8) & (at(-16) | at(0) | at(-4))) | (at(-16) & at(0) & at(-4));
      oam.copyWithin(r - 16, r - 8, r);
    } else if ((r & 0x18) === 0) {
      if (r === 0x40) {
        const [b, c, d, e, f, g, h] = [at(0), at(-4), at(-6), at(-8), at(-14), at(-16), at(-32)];
        w[(r - 8) >> 1] = (e & (h | g | (~d & f) | c | b)) | (c & g & h);
      } else {
        const [a, b, c, d, e] = [at(0), at(-4), at(-8), at(-16), at(-32)];
        w[(r - 8) >> 1] = r === 0x20 ? (c & (a | b | d | e)) | (a & b & d & e)
          : r === 0x60 ? (c & (a | b | d | e)) | (b & d & e)
          : c | (a & b & d & e);
      }
      oam.copyWithin(r - 16, r - 8, r);
      oam.copyWithin(r - 32, r - 8, r);
    } else {
      w[(r - 8) >> 1] = w[r >> 1] = at(-8) | (at(0) & at(-4));
    }
    oam.copyWithin(r, r - 8, r);
    if (r === 0x80) oam.copyWithin(0, 0x80, 0x88);
  }

  readRegister(addr) {
    switch (addr) {
      case 0xff40: return this.lcdc;
      case 0xff41:
        return 0x80 | this.statEnables | (this.coincidence ? 4 : 0) | (this.lcdc & 0x80 ? this.mode : 0);
      case 0xff42: return this.scy;
      case 0xff43: return this.scx;
      case 0xff44: return this.ly;
      case 0xff45: return this.lyc;
      case 0xff47: return this.bgp;
      case 0xff48: return this.obp0;
      case 0xff49: return this.obp1;
      case 0xff4a: return this.wy;
      case 0xff4b: return this.wx;
      case 0xff4f: return this.cgb ? 0xfe | this.vramBank : 0xff;
      case 0xff68: return this.cgb ? 0x40 | this.bcps : 0xff;
      case 0xff69: return this.cgb ? this.bgPaletteRam[this.bcps & 0x3f] : 0xff;
      case 0xff6a: return this.cgb ? 0x40 | this.ocps : 0xff;
      case 0xff6b: return this.cgb ? this.objPaletteRam[this.ocps & 0x3f] : 0xff;
      case 0xff6c: return this.cgb ? 0xfe | this.opri : 0xff;
      default: return 0xff;
    }
  }

  writeRegister(addr, value) {
    if (this.drawing) this.fifo.log(this.dot, addr, value, this.readRegister(addr));
    switch (addr) {
      case 0xff40:
        this.#writeLcdc(value);
        if (this.lcdc & 0x80) this.#checkWindowY();
        break;
      case 0xff41:
        // DMG bug: writing STAT briefly enables every source, so a write
        // during HBlank, VBlank or LY=LYC raises an interrupt.
        if (!this.cgb && this.lcdc & 0x80) {
          this.statEnables = 0x78;
          this.#updateStat();
        }
        this.statEnables = value & 0x78;
        if (this.lcdc & 0x80) this.#updateStat();
        break;
      case 0xff42: this.scy = value; break;
      case 0xff43: this.scx = value; break;
      case 0xff45:
        this.lyc = value;
        if (this.lcdc & 0x80) this.#compareLy();
        break;
      case 0xff47: this.bgp = value; this.#refreshColors(); break;
      case 0xff48: this.obp0 = value; this.#refreshColors(); break;
      case 0xff49: this.obp1 = value; this.#refreshColors(); break;
      case 0xff4a:
        this.wy = value;
        if (this.lcdc & 0x80) this.#checkWindowY();
        break;
      case 0xff4b: this.wx = value; break;
      case 0xff4f: if (this.cgb) this.vramBank = value & 1; break;
      case 0xff68: if (this.cgb) this.bcps = value & 0xbf; break;
      case 0xff69: if (this.cgb) this.bcps = this.#writePalette(this.bgPaletteRam, this.bgColors, this.bcps, value); break;
      case 0xff6a: if (this.cgb) this.ocps = value & 0xbf; break;
      case 0xff6b: if (this.cgb) this.ocps = this.#writePalette(this.objPaletteRam, this.objColors, this.ocps, value); break;
      case 0xff6c: if (this.cgb) this.opri = value & 1; break;
    }
  }

  /** Writes palette RAM through an index register; returns the (auto-incremented) index. */
  #writePalette(ram, colors, index, value) {
    const i = index & 0x3f;
    ram[i] = value;
    const entry = i >> 1;
    colors[entry] = cgbToPixel(ram[entry * 2] | (ram[entry * 2 + 1] << 8), this.colorCorrection);
    return index & 0x80 ? (index & 0x80) | ((i + 1) & 0x3f) : index;
  }

  /**
   * The DMG boot ROM hands over during line 153, LY already reading 0, `dot`
   * dots into the line.
   */
  startAfterBoot(dot) {
    this.lcdc = 0x91;
    this.ly = 0;
    this.mode = 1;
    this.irqMode = 1;
    this.dot = dot;
    this.coincidence = this.lyc === 0;
    this.#next(Phase.VBLANK_END, LINE_DOTS);
  }

  #writeLcdc(value) {
    const wasOn = this.lcdc & 0x80;
    this.lcdc = value;
    this.oamScan = false;
    if (wasOn && !(value & 0x80)) {
      this.ly = 0;
      this.mode = 0;
      this.irqMode = 0;
      this.#blockAccess(false);
      // The LY=LYC flag and the STAT interrupt line keep their state while off.
      this.front.fill(this.#blank());
    } else if (!wasOn && value & 0x80) {
      // The first line has no OAM scan and starts 4 dots short; STAT reads
      // mode 0 until drawing starts.
      this.ly = 0;
      this.dot = 4;
      this.#next(Phase.DRAWING, 84);
      this.windowLine = 0;
      this.windowTriggered = false;
      this.#checkWindowY();
      this.skipFrame = true;
      this.#compareLy();
    }
  }
}
