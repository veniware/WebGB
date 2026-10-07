import { CanvasRenderer } from './canvas-renderer.js';
import { WebGLRenderer } from './webgl-renderer.js';

/**
 * Owns the screen canvas: picks a renderer, sizes the canvas for the zoom
 * level and device pixel ratio, and handles fullscreen.
 */
export class Display {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLElement} stage  Element the canvas is centered in.
   * @param {HTMLElement} [fullscreenTarget]  Element made fullscreen (defaults to the stage).
   * @param {'auto' | 'webgl' | 'canvas'} [renderer]
   */
  constructor(canvas, stage, fullscreenTarget = stage, renderer = 'auto') {
    this.canvas = canvas;
    this.stage = stage;
    this.fullscreenTarget = fullscreenTarget;
    this.rendererKind = renderer;
    this.renderer = createRenderer(canvas, renderer);
    this.filter = undefined;
    this.dedither = false;
    // The last frame drawn, for redrawing with another renderer.
    this.frame = null;
    this.zoom = 'fit';
    this.width = 0;
    this.height = 0;
    new ResizeObserver(() => this.layout()).observe(stage);
    window.addEventListener('resize', () => this.layout());
  }

  get supportsShaders() {
    return this.renderer.supportsShaders;
  }

  get rendererName() {
    return this.renderer.supportsShaders ? 'WebGL' : 'Canvas 2D';
  }

  /**
   * Switches renderer. A canvas keeps the kind of context it was first given,
   * so a fresh one takes its place.
   * @param {'auto' | 'webgl' | 'canvas'} kind
   */
  setRenderer(kind) {
    if (kind === this.rendererKind) return;
    this.rendererKind = kind;
    const canvas = this.canvas.cloneNode(false);
    this.canvas.replaceWith(canvas);
    this.canvas = canvas;
    this.renderer = createRenderer(canvas, kind);
    this.renderer.setFilter(this.filter);
    this.renderer.setDedither(this.dedither);
    if (this.width) this.renderer.setSourceSize(this.width, this.height);
    this.layout();
    if (this.frame) this.renderer.draw(this.frame);
  }

  setSourceSize(width, height) {
    this.width = width;
    this.height = height;
    this.renderer.setSourceSize(width, height);
    this.layout();
  }

  /** @param {'fit' | number} zoom */
  setZoom(zoom) {
    this.zoom = zoom;
    this.layout();
  }

  setFilter(id) {
    this.filter = id;
    this.renderer.setFilter(id);
    this.renderer.draw();
  }

  setDedither(enabled) {
    this.dedither = enabled;
    this.renderer.setDedither(enabled);
    this.renderer.draw();
  }

  draw(frame) {
    if (frame) this.frame = frame;
    this.renderer.draw(frame);
  }

  layout() {
    const { width, height, stage, canvas } = this;
    if (!width) return;
    const fit = Math.min(stage.clientWidth / width, stage.clientHeight / height);
    const scale = this.zoom === 'fit' || document.fullscreenElement ? fit : this.zoom;
    const cssWidth = Math.max(1, Math.floor(width * scale));
    const cssHeight = Math.max(1, Math.floor(height * scale));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.resize(Math.round(cssWidth * dpr), Math.round(cssHeight * dpr));
    this.renderer.draw();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.fullscreenTarget.requestFullscreen?.().catch(() => {});
  }
}

function createRenderer(canvas, kind) {
  return (kind !== 'canvas' && WebGLRenderer.create(canvas)) || new CanvasRenderer(canvas);
}
