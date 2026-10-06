import { Emitter } from './emitter.js';
import { createCore } from '../core/registry.js';
import { loadRomFile } from '../rom/loader.js';
import { loadSave, storeSave } from '../storage/saves.js';
import { addSnapshot, deleteSnapshot, getSnapshot, listSnapshots } from '../storage/snapshots.js';
import { frameToBlob } from '../video/thumbnail.js';

/** Speed while the fast-forward hotkey is held (unless the selected speed is higher). */
export const FAST_FORWARD_SPEED = 4;
// Upper bound per animation frame, so a slow device can't spiral into ever-longer catch-up.
const MAX_FRAMES_PER_TICK = 20;
// Longest gap (ms) we catch up on, e.g. after the tab was in the background.
const MAX_TICK_GAP = 100;
const SAVE_CHECK_INTERVAL = 2000;

/**
 * The host: owns the running core and drives it from requestAnimationFrame,
 * feeding input, video, audio and storage.
 *
 * Events: 'loaded' ({ rom, fallback }), 'paused' (boolean), 'fps' (number),
 * 'snapshots' (list changed), 'status' ({ text, error? }).
 */
export class Emulator extends Emitter {
  /** @type {import('../core/interface.js').Core | null} */
  core = null;
  /** @type {import('../rom/loader.js').LoadedRom | null} */
  rom = null;
  paused = false;
  speed = 1;

  #display;
  #audio;
  #input;
  #frameDebt = 0;
  #lastTime = 0;
  #lastSave = null;
  #fpsFrames = 0;
  #fpsSince = 0;

  /**
   * @param {{ display: import('../video/display.js').Display, audio: import('../audio/audio-output.js').AudioOutput, input: import('../input/input-manager.js').InputManager }} deps
   */
  constructor({ display, audio, input }) {
    super();
    this.#display = display;
    this.#audio = audio;
    this.#input = input;
    setInterval(() => this.flushSave(), SAVE_CHECK_INTERVAL);
    document.addEventListener('visibilitychange', () => document.hidden && this.flushSave());
    window.addEventListener('pagehide', () => this.flushSave());
  }

  start() {
    requestAnimationFrame(this.#tick);
  }

  /** @param {File} file */
  async load(file) {
    const rom = await loadRomFile(file);
    const { core, fallback } = await createCore(rom.data, rom.info);
    await this.flushSave();

    const save = await loadSave(rom.key).catch((err) => console.warn('Could not read save data:', err));
    if (save) core.loadSaveData(save);

    this.core = core;
    this.rom = rom;
    this.#lastSave = core.getSaveData()?.slice() ?? null;
    this.#frameDebt = 0;
    this.#display.setSourceSize(core.width, core.height);
    this.#display.draw(core.getFrameBuffer());
    this.#audio.clear();
    this.setPaused(false);
    this.emit('loaded', { rom, fallback });
  }

  setPaused(paused) {
    this.paused = paused;
    this.emit('paused', paused);
  }

  reset() {
    if (!this.core) return;
    this.core.reset();
    this.#audio.clear();
    this.#display.draw(this.core.getFrameBuffer());
  }

  /** Writes battery-backed save data if it changed since the last write. */
  async flushSave() {
    const { core, rom } = this;
    const data = core?.getSaveData();
    if (!data || sameBytes(data, this.#lastSave)) return;
    const copy = data.slice();
    this.#lastSave = copy;
    try {
      await storeSave(rom.key, copy);
    } catch (err) {
      this.emit('status', { text: `Could not store save data: ${err.message}`, error: true });
    }
  }

  async takeSnapshot() {
    const { core, rom } = this;
    if (!core) return;
    const state = core.saveState();
    const thumbnail = await frameToBlob(core.getFrameBuffer(), core.width, core.height);
    await addSnapshot({
      romKey: rom.key,
      coreId: core.id,
      coreVersion: core.version,
      created: Date.now(),
      thumbnail,
      state,
    });
    this.emit('snapshots');
    this.emit('status', { text: 'Snapshot saved.' });
  }

  /** @returns {Promise<import('../storage/snapshots.js').SnapshotInfo[]>} */
  listSnapshots() {
    return this.rom ? listSnapshots(this.rom.key) : Promise.resolve([]);
  }

  async loadSnapshot(id) {
    const { core, rom } = this;
    const snapshot = core && (await getSnapshot(id));
    if (!snapshot || snapshot.romKey !== rom.key) throw new Error('Snapshot not found for this game.');
    if (snapshot.coreId !== core.id || snapshot.coreVersion !== core.version) {
      throw new Error('This snapshot was made with a different emulator core version.');
    }
    core.loadState(snapshot.state);
    this.#audio.clear();
    this.#display.draw(core.getFrameBuffer());
    this.emit('status', { text: 'Snapshot loaded.' });
  }

  async loadLatestSnapshot() {
    if (!this.core) return;
    const [latest] = await this.listSnapshots();
    if (!latest) throw new Error('No snapshots for this game yet.');
    await this.loadSnapshot(latest.id);
  }

  async deleteSnapshot(id) {
    await deleteSnapshot(id);
    this.emit('snapshots');
  }

  #tick = (now) => {
    requestAnimationFrame(this.#tick);
    const elapsed = Math.min(now - this.#lastTime, MAX_TICK_GAP);
    this.#lastTime = now;
    const input = this.#input.poll();
    const { core } = this;
    if (!core || this.paused) return;

    const speed = input.fastForward ? Math.max(FAST_FORWARD_SPEED, this.speed) : this.speed;
    this.#frameDebt += (elapsed / 1000) * core.fps * speed;
    let frames = Math.floor(this.#frameDebt);
    if (frames > MAX_FRAMES_PER_TICK) {
      frames = MAX_FRAMES_PER_TICK;
      this.#frameDebt = 0;
    } else {
      this.#frameDebt -= frames;
    }

    core.setInput(input.buttons);
    for (let i = 0; i < frames; i++) {
      core.runFrame();
      this.#audio.push(core.getAudioSamples(), core.sampleRate);
    }
    this.#audio.flush();
    if (frames) this.#display.draw(core.getFrameBuffer());

    this.#fpsFrames += frames;
    if (now - this.#fpsSince >= 500) {
      this.emit('fps', (this.#fpsFrames * 1000) / (now - this.#fpsSince));
      this.#fpsFrames = 0;
      this.#fpsSince = now;
    }
  };
}

function sameBytes(a, b) {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
