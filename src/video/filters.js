// Display filters. Each is a single WebGL2 fragment shader; `canvas` names
// the closest option for the 2D-canvas fallback ('nearest' or 'smooth').
// To add a filter, append an entry: its `main` can use source(), bilinear(),
// vUV, uSrcSize and uDstSize from the prelude.

export const VERTEX_SHADER = `#version 300 es
out vec2 vUV;
void main() {
  // One triangle that covers the viewport; vUV is 0..1 with the origin at the top-left.
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUV = vec2(pos.x + 1.0, 1.0 - pos.y) * 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const PRELUDE = `#version 300 es
precision highp float;
uniform sampler2D uTexture;
uniform vec2 uSrcSize;
uniform vec2 uDstSize;
uniform bool uDedither;
in vec2 vUV;
out vec4 fragColor;

vec3 texel(ivec2 p) {
  return texelFetch(uTexture, clamp(p, ivec2(0), ivec2(uSrcSize) - 1), 0).rgb;
}

// Source pixel, optionally de-dithered: checkerboards and 1px stripes are
// blended into flat color, single-pixel lines are left alone.
vec3 source(ivec2 p) {
  vec3 c = texel(p);
  if (!uDedither) return c;
  vec3 l = texel(p + ivec2(-1, 0)), r = texel(p + ivec2(1, 0));
  vec3 u = texel(p + ivec2(0, -1)), d = texel(p + ivec2(0, 1));
  bool h = l == r && l != c && texel(p + ivec2(-2, 0)) == c && texel(p + ivec2(2, 0)) == c;
  bool v = u == d && u != c && texel(p + ivec2(0, -2)) == c && texel(p + ivec2(0, 2)) == c;
  if (h && v) return mix(c, (l + u) * 0.5, 0.5);
  if (h) return mix(c, l, 0.5);
  if (v) return mix(c, u, 0.5);
  return c;
}

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
];

export function getFilter(id) {
  return FILTERS.find((filter) => filter.id === id) ?? FILTERS[0];
}

export function fragmentShader(filter) {
  return `${PRELUDE}\nvoid main() {\n${filter.main}\n}`;
}
