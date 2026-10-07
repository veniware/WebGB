// Containers and codecs to try, best first (Safari only records mp4).
const TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4;codecs=avc1,mp4a", "video/mp4"];

/** Records the screen (as drawn, with filters) and the sound to a video file. */
export class Recorder {
    #recorder = null;
    #chunks = [];
    #stopAudio = null;
    /** performance.now() when the recording started. */
    started = 0;

    static get supported() {
        return typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";
    }

    get recording() {
        return this.#recorder !== null;
    }

    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{ stream: MediaStream, stop: () => void } | null} audio    See AudioOutput.captureStream().
     */
    start(canvas, audio) {
        const stream = canvas.captureStream(60);
        for (const track of audio?.stream.getAudioTracks() ?? []) stream.addTrack(track);
        const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 8_000_000 } : {});
        recorder.ondataavailable = (e) => e.data.size && this.#chunks.push(e.data);
        this.#chunks = [];
        this.#stopAudio = audio?.stop ?? null;
        this.#recorder = recorder;
        // Data every second, so a long recording isn't one huge buffer at the end.
        recorder.start(1000);
        this.started = performance.now();
    }

    /** @returns {Promise<{ blob: Blob, extension: string }>} */
    stop() {
        const recorder = this.#recorder;
        this.#recorder = null;
        return new Promise((resolve, reject) => {
            recorder.onstop = () => {
                const type = recorder.mimeType || "video/webm";
                resolve({ blob: new Blob(this.#chunks, { type }), extension: type.includes("mp4") ? "mp4" : "webm" });
                this.#chunks = [];
            };
            recorder.onerror = (e) => reject(e.error ?? new Error("Recording failed."));
            recorder.stop();
            for (const track of recorder.stream.getTracks()) track.stop();
            this.#stopAudio?.();
            this.#stopAudio = null;
        });
    }
}
