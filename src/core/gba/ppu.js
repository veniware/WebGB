export const SCREEN_WIDTH = 240;
export const SCREEN_HEIGHT = 160;
const LINES = 228;
// Cycles per line: 960 drawing (4 per pixel), then 272 of HBlank.
export const LINE_CYCLES = 1232;
// HBlank (its DISPSTAT flag, DMA and interrupt) starts after 1008 cycles,
// though only 960 of them output pixels.
const HDRAW_CYCLES = 1008;
// The HBlank interrupt comes a little later still (as measured; mGBA).
const HBLANK_IRQ_DELAY = 8;

// Layers in the blend/window registers.
const OBJ = 4;
const BACKDROP = 5;
const TRANSPARENT = 0x8000;

// Sprite sizes [width, height] by shape (attr0 bits 14-15) and size (attr1 bits 14-15).
const OBJ_SIZES = [
  [[8, 8], [16, 16], [32, 32], [64, 64]],
  [[16, 8], [32, 8], [32, 16], [64, 32]],
  [[8, 16], [8, 32], [16, 32], [32, 64]],
  [[8, 8], [8, 8], [8, 8], [8, 8]],
];

/**
 * GBA video: registers, line timing (VBlank/HBlank/VCOUNT and their
 * interrupts and DMA triggers) and a scanline renderer for all six modes,
 * sprites (normal and affine), windows, blending and mosaic.
 */
export class Ppu {
  /**
   * @param {{ requestIrq: (bit: number, time: number) => void, onHblank: () => void, onVblank: () => void }} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.palette = new Uint8Array(0x400);
    this.palette16 = new Uint16Array(this.palette.buffer);
    this.palette32 = new Int32Array(this.palette.buffer);
    this.vram = new Uint8Array(0x18000);
    this.vram16 = new Uint16Array(this.vram.buffer);
    this.vram32 = new Int32Array(this.vram.buffer);
    this.oam = new Uint8Array(0x400);
    this.oam16 = new Uint16Array(this.oam.buffer);
    this.oam32 = new Int32Array(this.oam.buffer);
    this.bgcnt = new Uint16Array(4);
    this.hofs = new Uint16Array(4);
    this.vofs = new Uint16Array(4);
    // BG2 and BG3 affine parameters (index 0 = BG2) and their running reference points.
    this.pa = new Int16Array(2);
    this.pb = new Int16Array(2);
    this.pc = new Int16Array(2);
    this.pd = new Int16Array(2);
    this.refX = new Int32Array(2);
    this.refY = new Int32Array(2);
    this.lineX = new Int32Array(2);
    this.lineY = new Int32Array(2);
    // Per-line layer buffers: 15-bit colors, TRANSPARENT where nothing is drawn.
    this.layers = Array.from({ length: 4 }, () => new Uint16Array(SCREEN_WIDTH));
    this.objColor = new Uint16Array(SCREEN_WIDTH);
    this.objPriority = new Uint8Array(SCREEN_WIDTH);
    this.objSemi = new Uint8Array(SCREEN_WIDTH);
    this.objWindow = new Uint8Array(SCREEN_WIDTH);
    this.windowMask = new Uint8Array(SCREEN_WIDTH);
    // 15-bit BGR to RGBA.
    this.colors = new Uint32Array(0x8000);
    for (let c = 0; c < 0x8000; c++) {
      const r = c & 0x1f;
      const g = (c >> 5) & 0x1f;
      const b = (c >> 10) & 0x1f;
      this.colors[c] = 0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((r << 3) | (r >> 2));
    }
    this.front = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.back = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.frontBytes = new Uint8ClampedArray(this.front.buffer);
    this.backBytes = new Uint8ClampedArray(this.back.buffer);
    this.reset();
  }

  reset() {
    this.palette.fill(0);
    this.vram.fill(0);
    this.oam.fill(0);
    this.dispcnt = 0x80;
    this.greenSwap = 0;
    this.dispstat = 0;
    this.vcount = 0;
    this.bgcnt.fill(0);
    this.hofs.fill(0);
    this.vofs.fill(0);
    this.pa.fill(0x100);
    this.pb.fill(0);
    this.pc.fill(0);
    this.pd.fill(0x100);
    this.refX.fill(0);
    this.refY.fill(0);
    this.lineX.fill(0);
    this.lineY.fill(0);
    this.winH = [0, 0];
    this.winV = [0, 0];
    this.winin = 0;
    this.winout = 0;
    this.mosaic = 0;
    this.bldcnt = 0;
    this.bldalpha = 0;
    this.bldy = 0;
    this.hblank = false;
    // Time of the next line event: HBlank start or line end.
    this.nextEvent = HDRAW_CYCLES;
    this.lineStart = 0;
    this.frameDone = false;
    this.front.fill(0xff000000);
    this.back.fill(0xff000000);
  }

  sync(s) {
    s.bytes(this.palette);
    s.bytes(this.vram);
    s.bytes(this.oam);
    for (const r of ['dispcnt', 'greenSwap', 'dispstat', 'vcount', 'winin', 'winout', 'mosaic', 'bldcnt', 'bldalpha', 'bldy']) {
      this[r] = s.u16(this[r]);
    }
    for (const array of ['bgcnt', 'hofs', 'vofs', 'pa', 'pb', 'pc', 'pd', 'refX', 'refY', 'lineX', 'lineY']) s.bytes(this[array]);
    for (let i = 0; i < 2; i++) {
      this.winH[i] = s.u16(this.winH[i]);
      this.winV[i] = s.u16(this.winV[i]);
    }
    this.hblank = s.bool(this.hblank);
    this.nextEvent = s.f64(this.nextEvent);
    this.lineStart = s.f64(this.lineStart);
  }

  get mode() {
    return this.dispcnt & 7;
  }

  /** Bitmap modes use part of the sprite tile area. */
  get bitmapMode() {
    return (this.dispcnt & 7) >= 3;
  }

  // --- Registers ------------------------------------------------------------------

  read16(address) {
    switch (address) {
      case 0x00: return this.dispcnt;
      case 0x02: return this.greenSwap;
      case 0x04: return this.dispstat | (this.vcount >= 160 && this.vcount < 227 ? 1 : 0) | (this.hblank ? 2 : 0) |
        (this.vcount === this.dispstat >>> 8 ? 4 : 0);
      case 0x06: return this.vcount;
      case 0x08: case 0x0a: case 0x0c: case 0x0e: return this.bgcnt[(address - 8) >> 1];
      case 0x48: return this.winin;
      case 0x4a: return this.winout;
      case 0x50: return this.bldcnt;
      case 0x52: return this.bldalpha;
      default: return -1; // write-only: open bus
    }
  }

  write16(address, value) {
    switch (address) {
      case 0x00: this.dispcnt = value; break;
      case 0x02: this.greenSwap = value & 1; break;
      case 0x04: this.dispstat = value & 0xff38; break;
      case 0x08: case 0x0a: case 0x0c: case 0x0e:
        this.bgcnt[(address - 8) >> 1] = value & (address < 0x0c ? 0xdfff : 0xffff);
        break;
      case 0x10: case 0x14: case 0x18: case 0x1c: this.hofs[(address - 0x10) >> 2] = value & 0x1ff; break;
      case 0x12: case 0x16: case 0x1a: case 0x1e: this.vofs[(address - 0x12) >> 2] = value & 0x1ff; break;
      case 0x20: case 0x30: this.pa[(address - 0x20) >> 4] = value; break;
      case 0x22: case 0x32: this.pb[(address - 0x22) >> 4] = value; break;
      case 0x24: case 0x34: this.pc[(address - 0x24) >> 4] = value; break;
      case 0x26: case 0x36: this.pd[(address - 0x26) >> 4] = value; break;
      case 0x28: case 0x38: this.#setReference(this.refX, this.lineX, (address - 0x28) >> 4, value, false); break;
      case 0x2a: case 0x3a: this.#setReference(this.refX, this.lineX, (address - 0x2a) >> 4, value, true); break;
      case 0x2c: case 0x3c: this.#setReference(this.refY, this.lineY, (address - 0x2c) >> 4, value, false); break;
      case 0x2e: case 0x3e: this.#setReference(this.refY, this.lineY, (address - 0x2e) >> 4, value, true); break;
      case 0x40: case 0x42: this.winH[(address - 0x40) >> 1] = value; break;
      case 0x44: case 0x46: this.winV[(address - 0x44) >> 1] = value; break;
      case 0x48: this.winin = value & 0x3f3f; break;
      case 0x4a: this.winout = value & 0x3f3f; break;
      case 0x4c: this.mosaic = value; break;
      case 0x50: this.bldcnt = value & 0x3fff; break;
      case 0x52: this.bldalpha = value & 0x1f1f; break;
      case 0x54: this.bldy = value & 0x1f; break;
    }
  }

  /** BGxX/BGxY: 28-bit signed reference points; writing one restarts its line counter. */
  #setReference(ref, line, bg, value, high) {
    let v = ref[bg];
    v = high ? (v & 0xffff) | ((value & 0x0fff) << 16) : (v & ~0xffff) | value;
    v = (v << 4) >> 4;
    ref[bg] = v;
    line[bg] = v;
  }

  // --- Timing ---------------------------------------------------------------------

  /** Handles the line event due at `now` (HBlank start or line end). */
  event(now) {
    if (!this.hblank) {
      // HBlank starts: the line is drawn.
      this.hblank = true;
      this.nextEvent = this.lineStart + LINE_CYCLES;
      if (this.vcount < SCREEN_HEIGHT) {
        this.#renderLine(this.vcount);
        this.hooks.onHblank();
      }
      if (this.dispstat & 0x10) this.hooks.requestIrq(1, now + HBLANK_IRQ_DELAY);
      return;
    }
    this.hblank = false;
    this.lineStart = now;
    this.nextEvent = now + HDRAW_CYCLES;
    this.vcount = this.vcount + 1 === LINES ? 0 : this.vcount + 1;
    if (this.vcount === SCREEN_HEIGHT) {
      // VBlank: the frame is complete; affine reference points restart.
      [this.front, this.back] = [this.back, this.front];
      [this.frontBytes, this.backBytes] = [this.backBytes, this.frontBytes];
      this.frameDone = true;
      this.lineX.set(this.refX);
      this.lineY.set(this.refY);
      if (this.dispstat & 0x08) this.hooks.requestIrq(0, now);
      this.hooks.onVblank();
    }
    if (this.vcount === this.dispstat >>> 8 && this.dispstat & 0x20) this.hooks.requestIrq(2, now);
  }

  // --- Rendering ------------------------------------------------------------------

  #renderLine(y) {
    const out = this.back;
    const base = y * SCREEN_WIDTH;
    const dispcnt = this.dispcnt;
    if (dispcnt & 0x80) {
      // Forced blank: white.
      out.fill(0xffffffff, base, base + SCREEN_WIDTH);
      this.#advanceAffine();
      return;
    }
    const mode = dispcnt & 7;
    let enabled = (dispcnt >>> 8) & 0x1f;
    if (mode === 1) enabled &= 0x17;
    else if (mode === 2) enabled &= 0x1c;
    else if (mode >= 3) enabled &= 0x14;
    for (let bg = 0; bg < 4; bg++) {
      if (!(enabled & (1 << bg))) continue;
      const line = this.layers[bg];
      if (mode === 0 || (mode === 1 && bg < 2)) this.#textBackground(bg, y, line);
      else if (mode <= 2) this.#affineBackground(bg, line);
      else this.#bitmapBackground(mode, line);
      if (this.bgcnt[bg] & 0x40) this.#mosaicLine(line);
    }
    this.objColor.fill(TRANSPARENT);
    this.objWindow.fill(0);
    if (enabled & 0x10 || (dispcnt & 0x8000)) this.#sprites(y);
    this.#windows(y);
    this.#compose(base, enabled);
    this.#advanceAffine();
  }

  /** Affine backgrounds step their reference point by (PB, PD) each line. */
  #advanceAffine() {
    for (let i = 0; i < 2; i++) {
      this.lineX[i] += this.pb[i];
      this.lineY[i] += this.pd[i];
    }
  }

  #textBackground(bg, y, line) {
    const control = this.bgcnt[bg];
    const vram = this.vram;
    const vram16 = this.vram16;
    const palette = this.palette16;
    const charBase = ((control >>> 2) & 3) * 0x4000;
    const screenBase = ((control >>> 8) & 0x1f) * 0x800;
    const colors256 = (control & 0x80) !== 0;
    const size = control >>> 14;
    const widthMask = size & 1 ? 511 : 255;
    const heightMask = size & 2 ? 511 : 255;
    let mosaicY = y;
    if (control & 0x40) {
      const v = ((this.mosaic >>> 4) & 0xf) + 1;
      mosaicY -= y % v;
    }
    const py = (mosaicY + this.vofs[bg]) & heightMask;
    const tileRow = py >> 3;
    const hofs = this.hofs[bg];
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const px = (x + hofs) & widthMask;
      // Screen blocks of 32x32 tiles; a 512-wide map has two side by side.
      let block = (tileRow >> 5) * (size & 1 ? 2 : 1) + (px >> 8);
      if (size === 2) block = tileRow >> 5;
      const entry = vram16[(screenBase + block * 0x800 + ((tileRow & 31) * 32 + ((px >> 3) & 31)) * 2) >> 1];
      const tile = entry & 0x3ff;
      const tx = entry & 0x400 ? 7 - (px & 7) : px & 7;
      const ty = entry & 0x800 ? 7 - (py & 7) : py & 7;
      let index;
      let color;
      if (colors256) {
        const address = charBase + tile * 64 + ty * 8 + tx;
        index = address < 0x10000 ? vram[address] : 0;
        color = palette[index];
      } else {
        const address = charBase + tile * 32 + ty * 4 + (tx >> 1);
        const byte = address < 0x10000 ? vram[address] : 0;
        index = tx & 1 ? byte >> 4 : byte & 0xf;
        color = palette[(entry >>> 12) * 16 + index];
      }
      line[x] = index ? color & 0x7fff : TRANSPARENT;
    }
  }

  #affineBackground(bg, line) {
    const i = bg - 2;
    const control = this.bgcnt[bg];
    const vram = this.vram;
    const palette = this.palette16;
    const charBase = ((control >>> 2) & 3) * 0x4000;
    const screenBase = ((control >>> 8) & 0x1f) * 0x800;
    const sizeShift = 7 + (control >>> 14);
    const size = 1 << sizeShift;
    const tiles = size >> 3;
    const wrap = (control & 0x2000) !== 0;
    const pa = this.pa[i];
    const pc = this.pc[i];
    let x = this.lineX[i];
    let y = this.lineY[i];
    for (let sx = 0; sx < SCREEN_WIDTH; sx++, x += pa, y += pc) {
      let px = x >> 8;
      let py = y >> 8;
      if (wrap) {
        px &= size - 1;
        py &= size - 1;
      } else if (px < 0 || py < 0 || px >= size || py >= size) {
        line[sx] = TRANSPARENT;
        continue;
      }
      const tile = vram[screenBase + (py >> 3) * tiles + (px >> 3)];
      const index = vram[charBase + tile * 64 + (py & 7) * 8 + (px & 7)];
      line[sx] = index ? palette[index] & 0x7fff : TRANSPARENT;
    }
  }

  #bitmapBackground(mode, line) {
    const i = 0;
    const pa = this.pa[i];
    const pc = this.pc[i];
    let x = this.lineX[i];
    let y = this.lineY[i];
    const page = this.dispcnt & 0x10 ? 0xa000 : 0;
    const width = mode === 5 ? 160 : 240;
    const height = mode === 5 ? 128 : 160;
    for (let sx = 0; sx < SCREEN_WIDTH; sx++, x += pa, y += pc) {
      const px = x >> 8;
      const py = y >> 8;
      if (px < 0 || py < 0 || px >= width || py >= height) {
        line[sx] = TRANSPARENT;
        continue;
      }
      if (mode === 4) {
        const index = this.vram[page + py * 240 + px];
        line[sx] = index ? this.palette16[index] & 0x7fff : TRANSPARENT;
      } else {
        const offset = mode === 3 ? py * 240 + px : (page >> 1) + py * 160 + px;
        line[sx] = this.vram16[offset] & 0x7fff;
      }
    }
  }

  /** Horizontal mosaic: blocks repeat their first pixel. */
  #mosaicLine(line) {
    const size = (this.mosaic & 0xf) + 1;
    if (size === 1) return;
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      if (x % size) line[x] = line[x - (x % size)];
    }
  }

  #sprites(y) {
    const oam16 = this.oam16;
    const vram = this.vram;
    const palette = this.palette16;
    const oneDimensional = (this.dispcnt & 0x40) !== 0;
    const tileBase = 0x10000;
    const minTile = this.bitmapMode ? 512 : 0;
    const mosaicH = ((this.mosaic >>> 8) & 0xf) + 1;
    const mosaicV = ((this.mosaic >>> 12) & 0xf) + 1;
    const color = this.objColor;
    const priority = this.objPriority;
    const semi = this.objSemi;
    const window = this.objWindow;
    // Lower OAM indices win: draw in reverse... rather, skip pixels already taken
    // by a sprite of equal or higher priority.
    priority.fill(4);
    for (let i = 0; i < 128; i++) {
      const attr0 = oam16[i * 4];
      const attr1 = oam16[i * 4 + 1];
      const attr2 = oam16[i * 4 + 2];
      const affine = (attr0 & 0x100) !== 0;
      if (!affine && attr0 & 0x200) continue; // disabled
      const objMode = (attr0 >>> 10) & 3;
      if (objMode === 3) continue;
      const [width, height] = OBJ_SIZES[attr0 >>> 14][attr1 >>> 14];
      const double = affine && attr0 & 0x200;
      const boxW = double ? width * 2 : width;
      const boxH = double ? height * 2 : height;
      let top = attr0 & 0xff;
      if (top + boxH > 256) top -= 256;
      let lineY = y - top;
      if (lineY < 0 || lineY >= boxH) continue;
      const mosaic = (attr0 & 0x1000) !== 0;
      if (mosaic) lineY -= (y % mosaicV);
      let left = attr1 & 0x1ff;
      if (left >= 240) left -= 512;
      const colors256 = (attr0 & 0x2000) !== 0;
      const tile = attr2 & 0x3ff;
      if (tile < minTile) continue;
      const prio = (attr2 >>> 10) & 3;
      const pal = (attr2 >>> 12) * 16 + 256;
      const rowTiles = oneDimensional ? (colors256 ? width >> 2 : width >> 3) : 32;
      let pa = 0x100;
      let pb = 0;
      let pc = 0;
      let pd = 0x100;
      if (affine) {
        const param = ((attr1 >>> 9) & 0x1f) * 16;
        pa = (oam16[param + 3] << 16) >> 16;
        pb = (oam16[param + 7] << 16) >> 16;
        pc = (oam16[param + 11] << 16) >> 16;
        pd = (oam16[param + 15] << 16) >> 16;
      }
      const hflip = !affine && attr1 & 0x1000;
      const vflip = !affine && attr1 & 0x2000;
      for (let bx = 0; bx < boxW; bx++) {
        const sx = left + bx;
        if (sx < 0 || sx >= SCREEN_WIDTH) continue;
        let tx;
        let ty;
        if (affine) {
          const cx = bx - (boxW >> 1);
          const cy = lineY - (boxH >> 1);
          tx = ((pa * cx + pb * cy) >> 8) + (width >> 1);
          ty = ((pc * cx + pd * cy) >> 8) + (height >> 1);
          if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        } else {
          tx = hflip ? width - 1 - bx : bx;
          ty = vflip ? height - 1 - lineY : lineY;
        }
        if (mosaic) tx -= tx % mosaicH;
        let index;
        if (colors256) {
          const t = (tile & ~1) + (ty >> 3) * rowTiles + (tx >> 3) * 2;
          index = vram[tileBase + ((t * 32) & 0x7fff) + (ty & 7) * 8 + (tx & 7)];
        } else {
          const t = tile + (ty >> 3) * rowTiles + (tx >> 3);
          const byte = vram[tileBase + ((t * 32) & 0x7fff) + (ty & 7) * 4 + ((tx & 7) >> 1)];
          index = tx & 1 ? byte >> 4 : byte & 0xf;
        }
        if (!index) continue;
        if (objMode === 2) {
          window[sx] = 1;
          continue;
        }
        if (prio >= priority[sx]) continue;
        priority[sx] = prio;
        color[sx] = palette[colors256 ? 256 + index : pal + index] & 0x7fff;
        semi[sx] = objMode === 1 ? 1 : 0;
      }
    }
  }

  /** Which layers (and effects, bit 5) each pixel shows, from the windows. */
  #windows(y) {
    const mask = this.windowMask;
    const dispcnt = this.dispcnt;
    if (!(dispcnt & 0xe000)) {
      mask.fill(0x3f);
      return;
    }
    mask.fill(this.winout & 0x3f);
    if (dispcnt & 0x8000) {
      const inside = (this.winout >>> 8) & 0x3f;
      for (let x = 0; x < SCREEN_WIDTH; x++) if (this.objWindow[x]) mask[x] = inside;
    }
    for (let w = 1; w >= 0; w--) {
      if (!(dispcnt & (0x2000 << w))) continue;
      const y1 = this.winV[w] >>> 8;
      const y2 = this.winV[w] & 0xff;
      const inY = y1 <= y2 ? y >= y1 && y < y2 : y >= y1 || y < y2;
      if (!inY) continue;
      const x1 = this.winH[w] >>> 8;
      const x2 = this.winH[w] & 0xff;
      const inside = (this.winin >>> (w * 8)) & 0x3f;
      for (let x = 0; x < SCREEN_WIDTH; x++) {
        if (x1 <= x2 ? x >= x1 && x < x2 : x >= x1 || x < x2) mask[x] = inside;
      }
    }
  }

  #compose(base, enabled) {
    const out = this.back;
    const colors = this.colors;
    const layers = this.layers;
    const mask = this.windowMask;
    const backdrop = this.palette16[0] & 0x7fff;
    const bldcnt = this.bldcnt;
    const effect = (bldcnt >>> 6) & 3;
    const eva = Math.min(16, this.bldalpha & 0x1f);
    const evb = Math.min(16, (this.bldalpha >>> 8) & 0x1f);
    const evy = Math.min(16, this.bldy & 0x1f);
    // BG order by priority, then number.
    const order = [];
    for (let p = 0; p < 4; p++) {
      for (let bg = 0; bg < 4; bg++) if (enabled & (1 << bg) && (this.bgcnt[bg] & 3) === p) order.push(bg);
    }
    for (let x = 0; x < SCREEN_WIDTH; x++) {
      const visible = mask[x];
      let top = BACKDROP;
      let topColor = backdrop;
      let second = BACKDROP;
      let secondColor = backdrop;
      let found = 0;
      const objHere = enabled & 0x10 && visible & 0x10 && this.objColor[x] !== TRANSPARENT;
      const objPrio = objHere ? this.objPriority[x] : 4;
      let objPlaced = !objHere;
      for (let k = 0; k < order.length && found < 2; k++) {
        const bg = order[k];
        if (!(visible & (1 << bg))) continue;
        const color = layers[bg][x];
        if (color === TRANSPARENT) continue;
        if (!objPlaced && objPrio <= (this.bgcnt[bg] & 3)) {
          objPlaced = true;
          if (found === 0) [top, topColor] = [OBJ, this.objColor[x]];
          else [second, secondColor] = [OBJ, this.objColor[x]];
          found++;
          if (found === 2) break;
        }
        if (found === 0) [top, topColor] = [bg, color];
        else [second, secondColor] = [bg, color];
        found++;
      }
      if (!objPlaced && found < 2) {
        if (found === 0) [top, topColor] = [OBJ, this.objColor[x]];
        else [second, secondColor] = [OBJ, this.objColor[x]];
        found++;
      }
      let color = topColor;
      const semi = top === OBJ && this.objSemi[x];
      const secondTarget = (bldcnt >>> (8 + second)) & 1;
      if (semi && secondTarget) {
        color = blend(topColor, secondColor, eva, evb);
      } else if (visible & 0x20 && effect && (bldcnt >>> top) & 1) {
        if (effect === 1) {
          if (secondTarget && found >= 1) color = blend(topColor, secondColor, eva, evb);
        } else if (effect === 2) {
          color = brighten(topColor, evy);
        } else {
          color = darken(topColor, evy);
        }
      }
      out[base + x] = colors[color];
    }
  }
}

function blend(a, b, eva, evb) {
  const r = Math.min(31, ((a & 0x1f) * eva + (b & 0x1f) * evb) >> 4);
  const g = Math.min(31, (((a >> 5) & 0x1f) * eva + ((b >> 5) & 0x1f) * evb) >> 4);
  const bl = Math.min(31, (((a >> 10) & 0x1f) * eva + ((b >> 10) & 0x1f) * evb) >> 4);
  return r | (g << 5) | (bl << 10);
}

function brighten(c, evy) {
  const r = c & 0x1f;
  const g = (c >> 5) & 0x1f;
  const b = (c >> 10) & 0x1f;
  return (r + (((31 - r) * evy) >> 4)) | ((g + (((31 - g) * evy) >> 4)) << 5) | ((b + (((31 - b) * evy) >> 4)) << 10);
}

function darken(c, evy) {
  const r = c & 0x1f;
  const g = (c >> 5) & 0x1f;
  const b = (c >> 10) & 0x1f;
  return (r - ((r * evy) >> 4)) | ((g - ((g * evy) >> 4)) << 5) | ((b - ((b * evy) >> 4)) << 10);
}
