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
   */
  constructor(canvas, stage, fullscreenTarget = stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.fullscreenTarget = fullscreenTarget;
    this.renderer = WebGLRenderer.create(canvas) ?? new CanvasRenderer(canvas);
    this.zoom = 'fit';
    this.width = 0;
    this.height = 0;
    new ResizeObserver(() => this.layout()).observe(stage);
    window.addEventListener('resize', () => this.layout());
  }

  get supportsShaders() {
    return this.renderer.supportsShaders;
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
    this.renderer.setFilter(id);
    this.renderer.draw();
  }

  setDedither(enabled) {
    this.renderer.setDedither(enabled);
    this.renderer.draw();
  }

  draw(frame) {
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
