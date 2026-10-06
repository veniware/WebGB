import { inflateSync } from 'node:zlib';

/**
 * Minimal PNG decoder for comparing screenshots in tests: non-interlaced,
 * grayscale, RGB, palette or RGBA, any bit depth up to 8.
 * @param {Uint8Array} data
 * @returns {{ width: number, height: number, pixels: Uint8Array }} RGBA pixels
 */
export function decodePng(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos < data.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
    const body = data.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      depth = body[8];
      colorType = body[9];
      if (body[12]) throw new Error('Interlaced PNGs are not supported.');
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = inflateSync(Buffer.concat(idat));
  const rows = new Uint8Array(stride * height);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = previous[i];
      const c = i >= bpp ? previous[i - bpp] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = value;
    }
    previous = out;
  }

  const pixels = new Uint8Array(width * height * 4);
  const sample = (row, index) => {
    if (depth === 8) return row[index];
    const bit = index * depth;
    return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 3) {
        const i = sample(row, x);
        pixels.set(palette.subarray(i * 3, i * 3 + 3), o);
        pixels[o + 3] = transparency && i < transparency.length ? transparency[i] : 255;
      } else if (colorType === 0 || colorType === 4) {
        const v = Math.round((sample(row, x * channels) * 255) / ((1 << depth) - 1));
        pixels[o] = pixels[o + 1] = pixels[o + 2] = v;
        pixels[o + 3] = colorType === 4 ? row[x * 2 + 1] : 255;
      } else {
        pixels[o] = row[x * channels];
        pixels[o + 1] = row[x * channels + 1];
        pixels[o + 2] = row[x * channels + 2];
        pixels[o + 3] = colorType === 6 ? row[x * 4 + 3] : 255;
      }
    }
  }
  return { width, height, pixels };
}
