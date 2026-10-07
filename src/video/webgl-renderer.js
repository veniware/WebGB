import { EFFECTS_SHADER, fragmentShader, getFilter, GHOSTING_SHADER, VERTEX_SHADER } from './filters.js';

// LCD ghosting: how much of the previous picture stays each frame.
const GHOSTING_KEEP = 0.5;

/**
 * GPU renderer. Each new frame is uploaded to a texture, goes through the
 * enabled effects at the console's resolution (see filters.js), and is drawn
 * at the screen's size through the scaler filter.
 */
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
    this.effects = { ghosting: false, dedither: false, sharpen: false, outlines: false };
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindVertexArray(gl.createVertexArray());
    this.frame = this.#texture();
    // Ghosting ping-pongs between two pictures; `latest` is the newest.
    this.ghost = [this.#target(), this.#target()];
    this.latest = 0;
    this.ghostValid = false;
    this.effected = this.#target();
    // What the scaler draws, and whether it needs working out again.
    this.output = this.frame;
    this.dirty = true;
    this.ghostProgram = this.#build(GHOSTING_SHADER, ['uTexture', 'uSrcSize', 'uPrevious', 'uKeep']);
    this.effectsProgram = this.#build(EFFECTS_SHADER, ['uTexture', 'uSrcSize', 'uDedither', 'uSharpen', 'uOutlines']);
  }

  setSourceSize(width, height) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const { gl } = this;
    for (const texture of [this.frame, this.ghost[0].texture, this.ghost[1].texture, this.effected.texture]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.ghostValid = false;
    this.dirty = true;
  }

  setFilter(id) {
    this.filter = getFilter(id);
  }

  setDedither(enabled) {
    this.setEffects({ dedither: enabled });
  }

  /** @param {{ ghosting?: boolean, dedither?: boolean, sharpen?: boolean, outlines?: boolean }} effects */
  setEffects(effects) {
    Object.assign(this.effects, effects);
    if (!this.effects.ghosting) this.ghostValid = false;
    this.dirty = true;
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
      gl.bindTexture(gl.TEXTURE_2D, this.frame);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    }
    if (frame || this.dirty) this.#prepare(Boolean(frame));
    const program = this.#program(this.filter);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program.program);
    this.#bind(0, this.output, program.uTexture);
    gl.uniform2f(program.uSrcSize, this.width, this.height);
    gl.uniform2f(program.uDstSize, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Runs the effect passes; ghosting only advances with a new frame. */
  #prepare(newFrame) {
    const { gl, effects } = this;
    let input = this.frame;
    if (effects.ghosting) {
      if (newFrame) {
        const previous = this.ghost[this.latest];
        this.latest ^= 1;
        const program = this.ghostProgram;
        this.#target(this.ghost[this.latest]);
        gl.useProgram(program.program);
        this.#bind(0, this.frame, program.uTexture);
        this.#bind(1, previous.texture, program.uPrevious);
        gl.uniform2f(program.uSrcSize, this.width, this.height);
        gl.uniform1f(program.uKeep, this.ghostValid ? GHOSTING_KEEP : 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        this.ghostValid = true;
      }
      if (this.ghostValid) input = this.ghost[this.latest].texture;
    }
    if (effects.dedither || effects.sharpen || effects.outlines) {
      const program = this.effectsProgram;
      this.#target(this.effected);
      gl.useProgram(program.program);
      this.#bind(0, input, program.uTexture);
      gl.uniform2f(program.uSrcSize, this.width, this.height);
      gl.uniform1i(program.uDedither, effects.dedither ? 1 : 0);
      gl.uniform1i(program.uSharpen, effects.sharpen ? 1 : 0);
      gl.uniform1i(program.uOutlines, effects.outlines ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      input = this.effected.texture;
    }
    this.output = input;
    this.dirty = false;
  }

  #bind(unit, texture, location) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }

  #texture() {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }

  /**
   * Without an argument: a new render target (texture + framebuffer). With
   * one: renders into it from now on.
   */
  #target(target) {
    const { gl } = this;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, this.width, this.height);
      return target;
    }
    const texture = this.#texture();
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer };
  }

  #program(filter) {
    let entry = this.#programs.get(filter.id);
    if (!entry) {
      entry = this.#build(fragmentShader(filter), ['uTexture', 'uSrcSize', 'uDstSize'], filter.id);
      this.#programs.set(filter.id, entry);
    }
    return entry;
  }

  #build(fragmentSource, uniforms, name = 'effect') {
    const { gl } = this;
    const program = gl.createProgram();
    gl.attachShader(program, this.#shader(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, this.#shader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Shader "${name}" failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    const entry = { program };
    for (const uniform of uniforms) entry[uniform] = gl.getUniformLocation(program, uniform);
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
