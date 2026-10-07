// Display filters (scalers) and effects, as WebGL2 shaders.
//
// A new frame goes through effect passes at the console's resolution (LCD
// ghosting, then de-dither / sharpen / outlines), then a scaler draws it at
// the screen's size. Scalers are single fragment shaders; `canvas` names the
// closest option for the 2D-canvas fallback ('nearest' or 'smooth'). To add a
// scaler, append an entry: its `main` can use source(), bilinear(), vUV,
// uSrcSize and uDstSize from the prelude.

export const VERTEX_SHADER = `#version 300 es
out vec2 vUV;
void main() {
  // One triangle that covers the viewport; vUV is 0..1 with the origin at the top-left.
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUV = vec2(pos.x + 1.0, 1.0 - pos.y) * 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uSrcSize;
in vec2 vUV;
out vec4 fragColor;

vec3 source(ivec2 p) {
  return texelFetch(uTexture, clamp(p, ivec2(0), ivec2(uSrcSize) - 1), 0).rgb;
}
`;

const PRELUDE = `${COMMON}
uniform vec2 uDstSize;

// Bilinear sample at a position in texel units (texel centers at +0.5).
vec3 bilinear(vec2 pos) {
  pos -= 0.5;
  ivec2 i = ivec2(floor(pos));
  vec2 f = pos - floor(pos);
  vec3 top = mix(source(i), source(i + ivec2(1, 0)), f.x);
  vec3 bottom = mix(source(i + ivec2(0, 1)), source(i + ivec2(1, 1)), f.x);
  return mix(top, bottom, f.y);
}
`;

/** LCD ghosting: each frame blends with what the screen showed before. */
export const GHOSTING_SHADER = `${COMMON}
uniform sampler2D uPrevious;
uniform float uKeep;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  fragColor = vec4(mix(source(p), texelFetch(uPrevious, p, 0).rgb, uKeep), 1.0);
}`;

/** Effects at the console's resolution: de-dither, sharpen, outlines. */
export const EFFECTS_SHADER = `${COMMON}
uniform bool uDedither;
uniform bool uSharpen;
uniform bool uOutlines;

// Checkerboards and 1px stripes are blended into flat color; single-pixel
// lines are left alone.
vec3 dedithered(ivec2 p) {
  vec3 c = source(p);
  vec3 l = source(p + ivec2(-1, 0)), r = source(p + ivec2(1, 0));
  vec3 u = source(p + ivec2(0, -1)), d = source(p + ivec2(0, 1));
  bool h = l == r && l != c && source(p + ivec2(-2, 0)) == c && source(p + ivec2(2, 0)) == c;
  bool v = u == d && u != c && source(p + ivec2(0, -2)) == c && source(p + ivec2(0, 2)) == c;
  if (h && v) return mix(c, (l + u) * 0.5, 0.5);
  if (h) return mix(c, l, 0.5);
  if (v) return mix(c, u, 0.5);
  return c;
}

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = uDedither ? dedithered(p) : source(p);
  if (uSharpen) {
    // Unsharp mask over the four neighbors.
    vec3 around = source(p + ivec2(-1, 0)) + source(p + ivec2(1, 0)) + source(p + ivec2(0, -1)) + source(p + ivec2(0, 1));
    c = clamp(c + (c * 4.0 - around) * 0.2, 0.0, 1.0);
  }
  if (uOutlines) {
    // Sobel on brightness: dark lines where it changes sharply.
    float tl = luma(source(p + ivec2(-1, -1))), t = luma(source(p + ivec2(0, -1))), tr = luma(source(p + ivec2(1, -1)));
    float l = luma(source(p + ivec2(-1, 0))), r = luma(source(p + ivec2(1, 0)));
    float bl = luma(source(p + ivec2(-1, 1))), b = luma(source(p + ivec2(0, 1))), br = luma(source(p + ivec2(1, 1)));
    float gx = tr + 2.0 * r + br - tl - 2.0 * l - bl;
    float gy = bl + 2.0 * b + br - tl - 2.0 * t - tr;
    c *= 1.0 - 0.75 * smoothstep(0.35, 1.0, length(vec2(gx, gy)));
  }
  fragColor = vec4(c, 1.0);
}`;

export const FILTERS = [
  {
    id: 'sharp-bilinear',
    name: 'Sharp',
    canvas: 'nearest',
    // Crisp pixels with even sizes at any zoom: blends only across pixel edges.
    main: `
      vec2 pos = vUV * uSrcSize;
      vec2 scale = uDstSize / uSrcSize;
      vec2 center = fract(pos) - 0.5;
      vec2 range = 0.5 - 0.5 / scale;
      vec2 f = (center - clamp(center, -range, range)) * scale + 0.5;
      fragColor = vec4(bilinear(floor(pos) + f), 1.0);`,
  },
  {
    id: 'nearest',
    name: 'Nearest',
    canvas: 'nearest',
    main: `fragColor = vec4(source(ivec2(floor(vUV * uSrcSize))), 1.0);`,
  },
  {
    id: 'bilinear',
    name: 'Smooth',
    canvas: 'smooth',
    main: `fragColor = vec4(bilinear(vUV * uSrcSize), 1.0);`,
  },
  {
    id: 'scale2x',
    name: 'Scale2x (EPX)',
    canvas: 'nearest',
    // Edge-smoothing pixel-art upscaler: each pixel splits into 2x2 sub-pixels.
    main: `
      vec2 pos = vUV * uSrcSize;
      ivec2 p = ivec2(floor(pos));
      vec2 f = fract(pos);
      vec3 e = source(p);
      vec3 up = source(p + ivec2(0, -1)), down = source(p + ivec2(0, 1));
      vec3 left = source(p + ivec2(-1, 0)), right = source(p + ivec2(1, 0));
      vec3 o = e;
      if (f.y < 0.5) {
        if (f.x < 0.5) { if (left == up && up != right && left != down) o = up; }
        else { if (up == right && up != left && right != down) o = right; }
      } else {
        if (f.x < 0.5) { if (left == down && left != up && down != right) o = left; }
        else { if (down == right && down != left && right != up) o = down; }
      }
      fragColor = vec4(o, 1.0);`,
  },
  {
    id: 'xbr',
    name: 'Smooth edges (xBR)',
    canvas: 'smooth',
    // xBR-style: where an edge runs diagonally across a pixel's corner (it is
    // more continuous along that diagonal than across it), the corner takes
    // the neighbor's color along an antialiased 45-degree line.
    helpers: `
      float dist(vec3 a, vec3 b) {
        vec3 d = abs(a - b);
        return d.r * 0.299 + d.g * 0.587 + d.b * 0.114;
      }

      // The corner of pixel p towards (dx, dy); f: position in the pixel, 0..1 towards that corner.
      vec3 corner(ivec2 p, ivec2 dx, ivec2 dy, vec2 f, vec3 color) {
        vec3 e = source(p), fr = source(p + dx), h = source(p + dy), i = source(p + dx + dy);
        if (e == fr || e == h) return color;
        vec3 c = source(p + dx - dy), g = source(p - dx + dy);
        vec3 f4 = source(p + 2 * dx), h5 = source(p + 2 * dy);
        vec3 d = source(p - dx), b = source(p - dy);
        vec3 i5 = source(p + dx + 2 * dy), i4 = source(p + 2 * dx + dy);
        float along = dist(e, c) + dist(e, g) + dist(i, f4) + dist(i, h5) + 4.0 * dist(h, fr);
        float across = dist(h, d) + dist(h, i5) + dist(fr, i4) + dist(fr, b) + 4.0 * dist(e, i);
        if (along >= across) return color;
        vec3 edge = dist(e, fr) <= dist(e, h) ? fr : h;
        float w = fwidth(f.x + f.y);
        return mix(color, edge, smoothstep(1.5 - w, 1.5 + w, f.x + f.y));
      }`,
    main: `
      vec2 pos = vUV * uSrcSize;
      ivec2 p = ivec2(floor(pos));
      vec2 f = fract(pos);
      vec3 o = source(p);
      o = corner(p, ivec2(1, 0), ivec2(0, 1), f, o);
      o = corner(p, ivec2(-1, 0), ivec2(0, 1), vec2(1.0 - f.x, f.y), o);
      o = corner(p, ivec2(1, 0), ivec2(0, -1), vec2(f.x, 1.0 - f.y), o);
      o = corner(p, ivec2(-1, 0), ivec2(0, -1), 1.0 - f, o);
      fragColor = vec4(o, 1.0);`,
  },
  {
    id: 'lcd',
    name: 'LCD grid',
    canvas: 'nearest',
    // Each pixel as an LCD cell with a thin dark gap (when it is at least 3
    // screen pixels wide), colors from the sharp scaler.
    main: `
      vec2 pos = vUV * uSrcSize;
      vec2 scale = uDstSize / uSrcSize;
      vec2 center = fract(pos) - 0.5;
      vec2 range = 0.5 - 0.5 / scale;
      vec3 c = bilinear(floor(pos) + (center - clamp(center, -range, range)) * scale + 0.5);
      vec2 inCell = fract(pos) * scale;
      bool gap = (scale.x >= 3.0 && inCell.x < 1.0) || (scale.y >= 3.0 && inCell.y < 1.0);
      fragColor = vec4(gap ? c * 0.78 : c, 1.0);`,
  },
  {
    id: 'crt',
    name: 'CRT',
    canvas: 'smooth',
    // Scanlines (each line brightest in its middle), a soft horizontal blur
    // and an aperture-grille mask; brightened to make up for the dark parts.
    main: `
      vec2 pos = vUV * uSrcSize;
      vec3 c = bilinear(vec2(pos.x, floor(pos.y) + 0.5));
      float scan = 0.6 + 0.4 * sin(3.14159265 * fract(pos.y));
      int column = int(mod(gl_FragCoord.x, 3.0));
      vec3 mask = vec3(column == 0 ? 1.0 : 0.75, column == 1 ? 1.0 : 0.75, column == 2 ? 1.0 : 0.75);
      fragColor = vec4(min(c * scan * mask * 1.35, 1.0), 1.0);`,
  },
];

export function getFilter(id) {
  return FILTERS.find((filter) => filter.id === id) ?? FILTERS[0];
}

export function fragmentShader(filter) {
  return `${PRELUDE}\n${filter.helpers ?? ''}\nvoid main() {\n${filter.main}\n}`;
}
