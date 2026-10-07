import { getFilter } from './filters.js';

/** Fallback renderer for browsers without WebGL2: nearest or smooth scaling only, no effects. */
export class CanvasRenderer {
    supportsShaders = false;
    name = 'Canvas 2D';

    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d', { alpha: false });
        this.source = document.createElement('canvas');
        this.sourceContext = this.source.getContext('2d');
        this.filter = getFilter();
        this.image = null;
    }

    setSourceSize(width, height) {
        this.source.width = width;
        this.source.height = height;
        this.image = null;
    }

    setFilter(id) {
        this.filter = getFilter(id);
    }

    setDedither() {}

    setEffects() {}

    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    draw(frame) {
        const { source, canvas, context } = this;
        if (!source.width) return;
        if (frame) {
            if (this.image?.data !== frame) this.image = new ImageData(frame, source.width, source.height);
            this.sourceContext.putImageData(this.image, 0, 0);
        }
        context.imageSmoothingEnabled = this.filter.canvas === 'smooth';
        context.drawImage(source, 0, 0, canvas.width, canvas.height);
    }
}
