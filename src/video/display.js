import { CanvasRenderer } from "./canvas-renderer.js";
import { WebGLRenderer } from "./webgl-renderer.js";
import { WebGPURenderer } from "./webgpu-renderer.js";

/**
 * Owns the screen canvas: picks a renderer, sizes the canvas for the zoom
 * level and device pixel ratio, and handles fullscreen.
 */
export class Display {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLElement} stage    Element the canvas is centered in.
     * @param {HTMLElement} [fullscreenTarget]    Element made fullscreen (defaults to the stage).
     * @param {'auto' | 'webgpu' | 'webgl' | 'canvas'} [renderer]    'auto': WebGL, or the 2D canvas without it.
     */
    constructor(canvas, stage, fullscreenTarget = stage, renderer = "auto") {
        this.canvas = canvas;
        this.stage = stage;
        this.fullscreenTarget = fullscreenTarget;
        // WebGPU starts asynchronously: WebGL draws until it is ready.
        this.rendererKind = renderer === "webgpu" ? "auto" : renderer;
        this.renderer = createRenderer(canvas, this.rendererKind);
        this.filter = undefined;
        this.dedither = false;
        this.effects = {};
        // The last frame drawn, for redrawing with another renderer.
        this.frame = null;
        this.zoom = "fit";
        this.width = 0;
        this.height = 0;
        new ResizeObserver(() => this.layout()).observe(stage);
        window.addEventListener("resize", () => this.layout());
        /** Settles once the renderer asked for is in place: false if WebGPU isn't available. */
        this.ready = renderer === "webgpu" ? this.setRenderer("webgpu") : Promise.resolve(true);
    }

    get supportsShaders() {
        return this.renderer.supportsShaders;
    }

    get rendererName() {
        return this.renderer.name;
    }

    /**
     * Switches renderer. A canvas keeps the kind of context it was first given,
     * so a fresh one takes its place. WebGPU starts asynchronously; until it is
     * ready, and if it isn't available, the current renderer keeps drawing.
     * @param {'auto' | 'webgpu' | 'webgl' | 'canvas'} kind
     * @returns {Promise<boolean>} false when WebGPU was asked for but isn't available.
     */
    async setRenderer(kind) {
        if (kind === this.rendererKind) return true;
        this.rendererKind = kind;
        const canvas = this.canvas.cloneNode(false);
        if (kind !== "webgpu") {
            this.#use(canvas, createRenderer(canvas, kind));
            return true;
        }
        const renderer = await WebGPURenderer.create(canvas);
        if (this.rendererKind !== "webgpu") {
            // Another renderer was picked meanwhile.
            renderer?.destroy();
            return true;
        }
        if (!renderer) {
            // Picking WebGPU again tries anew.
            this.rendererKind = "unavailable";
            return false;
        }
        renderer.onLost = (info) => {
            if (this.renderer !== renderer) return;
            console.warn("WebGPU device lost, switching to WebGL:", info.message);
            // Picking WebGPU again tries anew.
            this.rendererKind = "lost";
            const fallback = this.canvas.cloneNode(false);
            this.#use(fallback, createRenderer(fallback, "auto"));
        };
        this.#use(canvas, renderer);
        return true;
    }

    /** Puts `canvas` and its renderer in place of the current ones. */
    #use(canvas, renderer) {
        this.renderer.destroy?.();
        this.canvas.replaceWith(canvas);
        this.canvas = canvas;
        this.renderer = renderer;
        this.renderer.setFilter(this.filter);
        this.renderer.setDedither(this.dedither);
        this.renderer.setEffects(this.effects);
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

    /** @param {{ ghosting?: boolean, sharpen?: boolean, outlines?: boolean }} effects    See filters.js. */
    setEffects(effects) {
        Object.assign(this.effects, effects);
        this.renderer.setEffects(this.effects);
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
        const scale = this.zoom === "fit" || document.fullscreenElement ? fit : this.zoom;
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
    return (kind !== "canvas" && WebGLRenderer.create(canvas)) || new CanvasRenderer(canvas);
}
