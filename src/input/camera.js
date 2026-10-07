/**
 * Webcam frames for the Game Boy Camera: the front camera, center-cropped
 * and scaled to the sensor size, as 8-bit grayscale.
 */
export class CameraInput {
    #video = null;
    #stream = null;
    #canvas = null;
    #context = null;
    #pixels = null;
    #lastCapture = 0;

    get active() {
        return this.#stream !== null;
    }

    /**
     * Starts the webcam (asks for permission). Resolves to false when there is
     * no camera or the user declines.
     */
    async start(width, height) {
        if (this.#stream) return true;
        if (!navigator.mediaDevices?.getUserMedia) return false;
        try {
            this.#stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        } catch {
            return false;
        }
        this.#video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
        this.#video.srcObject = this.#stream;
        await this.#video.play().catch(() => {});
        this.#canvas = Object.assign(document.createElement('canvas'), { width, height });
        this.#context = this.#canvas.getContext('2d', { willReadFrequently: true });
        this.#pixels = new Uint8Array(width * height);
        return true;
    }

    stop() {
        this.#stream?.getTracks().forEach((track) => track.stop());
        this.#stream = null;
        this.#video = null;
    }

    /** The latest frame (at most 10 per second), or null before the camera runs. */
    frame(now = performance.now()) {
        const video = this.#video;
        if (!video || video.readyState < 2) return null;
        if (now - this.#lastCapture < 100) return this.#pixels;
        this.#lastCapture = now;
        const { width, height } = this.#canvas;
        // Cover-crop the video to the sensor's aspect ratio; mirrored like a selfie.
        const scale = Math.max(width / video.videoWidth, height / video.videoHeight);
        const w = width / scale;
        const h = height / scale;
        const ctx = this.#context;
        ctx.save();
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(video, (video.videoWidth - w) / 2, (video.videoHeight - h) / 2, w, h, 0, 0, width, height);
        ctx.restore();
        const rgba = ctx.getImageData(0, 0, width, height).data;
        for (let i = 0; i < this.#pixels.length; i++) {
            this.#pixels[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
        }
        return this.#pixels;
    }
}
