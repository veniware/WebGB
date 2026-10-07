import { EFFECTS_WGSL, getFilter, GHOSTING_KEEP, GHOSTING_WGSL, wgslShader } from "./filters.js";

// Format of the frame and of the effect passes' pictures.
const FORMAT = "rgba8unorm";

/**
 * WebGPU renderer, the same pipeline as WebGLRenderer: each new frame is
 * uploaded to a texture, goes through the enabled effects at the console's
 * resolution, and is drawn at the screen's size through the scaler. All
 * passes share one uniform buffer (see Params in filters.js).
 */
export class WebGPURenderer {
    supportsShaders = true;
    name = "WebGPU";
    /** Called once if the GPU is lost (driver reset, ...); the renderer is then unusable. */
    onLost = null;
    #pipelines = new Map();
    #params = new Float32Array(8);

    /**
     * WebGPU starts asynchronously.
     * @returns {Promise<WebGPURenderer | null>} null when WebGPU isn't available.
     */
    static async create(canvas) {
        const gpu = globalThis.navigator?.gpu;
        if (!gpu) return null;
        try {
            const adapter = await gpu.requestAdapter();
            const device = await adapter?.requestDevice();
            const context = device && canvas.getContext("webgpu");
            if (!context) return null;
            const format = gpu.getPreferredCanvasFormat();
            context.configure({ device, format, alphaMode: "opaque" });
            return new WebGPURenderer(canvas, adapter, device, context, format);
        } catch (err) {
            console.warn("WebGPU unavailable:", err);
            return null;
        }
    }

    constructor(canvas, adapter, device, context, format) {
        this.canvas = canvas;
        // Kept: some browsers lose the device once the adapter is garbage collected.
        this.adapter = adapter;
        this.device = device;
        this.context = context;
        this.format = format;
        this.width = 0;
        this.height = 0;
        this.filter = getFilter();
        this.effects = { ghosting: false, dedither: false, sharpen: false, outlines: false };
        this.uniforms = device.createBuffer({ size: this.#params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.ghostPipeline = this.#pipeline("ghosting", GHOSTING_WGSL, FORMAT);
        this.effectsPipeline = this.#pipeline("effects", EFFECTS_WGSL, FORMAT);
        this.frame = null;
        // Ghosting ping-pongs between two pictures; `latest` is the newest.
        this.ghost = [null, null];
        this.latest = 0;
        this.ghostValid = false;
        this.effected = null;
        // What the scaler draws, and whether it needs working out again.
        this.output = null;
        this.dirty = true;
        device.lost.then((info) => {
            if (info.reason !== "destroyed") this.onLost?.(info);
        });
    }

    setSourceSize(width, height) {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        for (const texture of [this.frame, this.ghost[0], this.ghost[1], this.effected]) texture?.destroy();
        const size = { width, height };
        this.frame = this.device.createTexture({ size, format: FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        const target = () => this.device.createTexture({
            size, format: FORMAT, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.ghost = [target(), target()];
        this.effected = target();
        this.output = this.frame;
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

    destroy() {
        this.device.destroy();
    }

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    /** Draws `frame` (RGBA), or redraws the last frame when omitted. */
    draw(frame) {
        const { device, canvas, effects, width, height } = this;
        if (!width || !canvas.width || !canvas.height) return;
        if (frame) {
            device.queue.writeTexture({ texture: this.frame }, frame, { bytesPerRow: width * 4 }, { width, height });
        }
        const prepare = Boolean(frame) || this.dirty;
        const params = this.#params;
        params[0] = width;
        params[1] = height;
        params[2] = canvas.width;
        params[3] = canvas.height;
        params[4] = this.ghostValid ? GHOSTING_KEEP : 0;
        params[5] = effects.dedither ? 1 : 0;
        params[6] = effects.sharpen ? 1 : 0;
        params[7] = effects.outlines ? 1 : 0;
        device.queue.writeBuffer(this.uniforms, 0, params);
        const encoder = device.createCommandEncoder();
        if (prepare) this.#prepare(encoder, Boolean(frame));
        this.#pass(encoder, this.#scaler(this.filter), this.context.getCurrentTexture(), this.output);
        device.queue.submit([encoder.finish()]);
    }

    /** The effect passes; ghosting only advances with a new frame. */
    #prepare(encoder, newFrame) {
        const { effects } = this;
        let input = this.frame;
        if (effects.ghosting) {
            if (newFrame) {
                const previous = this.ghost[this.latest];
                this.latest ^= 1;
                this.#pass(encoder, this.ghostPipeline, this.ghost[this.latest], this.frame, previous);
                this.ghostValid = true;
            }
            if (this.ghostValid) input = this.ghost[this.latest];
        }
        if (effects.dedither || effects.sharpen || effects.outlines) {
            this.#pass(encoder, this.effectsPipeline, this.effected, input);
            input = this.effected;
        }
        this.output = input;
        this.dirty = false;
    }

    /** One full-screen triangle from `source` (and `previous`) into `target`. */
    #pass(encoder, pipeline, target, source, previous = null) {
        const entries = [
            { binding: 0, resource: source.createView() },
            { binding: 2, resource: { buffer: this.uniforms } },
        ];
        if (previous) entries.push({ binding: 1, resource: previous.createView() });
        const bindGroup = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.end();
    }

    #scaler(filter) {
        let pipeline = this.#pipelines.get(filter.id);
        if (!pipeline) {
            pipeline = this.#pipeline(filter.id, wgslShader(filter), this.format);
            this.#pipelines.set(filter.id, pipeline);
        }
        return pipeline;
    }

    #pipeline(name, code, format) {
        const module = this.device.createShaderModule({ label: name, code });
        // Shader errors otherwise only show as a lost device or a blank screen.
        module.getCompilationInfo?.().then((info) => {
            for (const message of info.messages) {
                if (message.type === "error") console.error(`Shader "${name}" line ${message.lineNum}: ${message.message}`);
            }
        }, () => {});
        return this.device.createRenderPipeline({
            label: name,
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
            primitive: { topology: "triangle-list" },
        });
    }
}
