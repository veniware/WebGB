import { fragmentShader, getFilter, VERTEX_SHADER } from './filters.js';

/** GPU renderer: uploads each frame to a texture and draws it through a filter shader. */
export class WebGLRenderer {
  supportsShaders = true;
  #programs = new Map();

  /** @returns {WebGLRenderer | null} */
  static create(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    return gl ? new WebGLRenderer(canvas, gl) : null;
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.width = 0;
    this.height = 0;
    this.filter = getFilter();
    this.dedither = false;

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindVertexArray(gl.createVertexArray());
  }

  setSourceSize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const { gl } = this;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  setFilter(id) {
    this.filter = getFilter(id);
  }

  setDedither(enabled) {
    this.dedither = enabled;
  }

  resize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /** Draws `frame` (RGBA), or redraws the last frame when omitted. */
  draw(frame) {
    const { gl, canvas } = this;
    if (!this.width) return;
    if (frame) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    }
    const program = this.#program(this.filter);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program.program);
    gl.uniform1i(program.texture, 0);
    gl.uniform2f(program.srcSize, this.width, this.height);
    gl.uniform2f(program.dstSize, canvas.width, canvas.height);
    gl.uniform1i(program.dedither, this.dedither ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  #program(filter) {
    let entry = this.#programs.get(filter.id);
    if (entry) return entry;
    const { gl } = this;
    const program = gl.createProgram();
    gl.attachShader(program, this.#shader(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, this.#shader(gl.FRAGMENT_SHADER, fragmentShader(filter)));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Filter "${filter.id}" failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    entry = {
      program,
      texture: gl.getUniformLocation(program, 'uTexture'),
      srcSize: gl.getUniformLocation(program, 'uSrcSize'),
      dstSize: gl.getUniformLocation(program, 'uDstSize'),
      dedither: gl.getUniformLocation(program, 'uDedither'),
    };
    this.#programs.set(filter.id, entry);
    return entry;
  }

  #shader(type, sourceCode) {
    const { gl } = this;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, sourceCode);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }
}
