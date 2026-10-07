import { Emitter } from './emitter.js';
import { canLink, createCore, createLinkedCore } from '../core/registry.js';
import { getRom, getRomData, touchRom } from '../storage/roms.js';
import { createSave, getSave, updateSave } from '../storage/saves.js';
import { addSnapshot, getSnapshot, listSnapshots } from '../storage/snapshots.js';
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
 * In-game saves go to the active saved game (`saveId`); when there is none
 * yet, the first save creates one.
 *
 * Events: 'loaded' ({ rom, fallback }), 'stopped', 'paused' (boolean),
 * 'fps' (number), 'snapshots' (list changed), 'status' ({ text, error? }),
 * 'linked' (player 2's rom), 'unlinked'.
 */
export class Emulator extends Emitter {
  /** @type {import('../core/interface.js').Core | null} */
  core = null;
  /** @type {{ key: string, name: string, info: import('../rom/detect.js').RomInfo, size: number } | null} */
  rom = null;
  /** @type {number | null} Saved game that in-game saves are written to. */
  saveId = null;
  /**
   * Player 2's game when two games are linked by cable.
   * @type {{ rom: { key: string, name: string, info: import('../rom/detect.js').RomInfo, size: number }, saveId: number | null } | null}
   */
  player2 = null;
  paused = false;
  speed = 1;

  #display;
  #audio;
  #input;
  #motion;
  #camera;
  #rumble;
  #coreOptions = {};
  #frameDebt = 0;
  #lastTime = 0;
  // Buttons seen since the last emulated frame; on high-refresh displays some
  // animation frames run no emulated frame, and short taps must not be lost.
  #pendingButtons = 0;
  #lastSave = null;
  #lastSave2 = null;
  // The single-player core while linked; it keeps running after unlinking.
  #single = null;
  #saveQueue = Promise.resolve();
  // Per player: the screen when the game started writing its save, and the
  // core's save-write count last seen.
  #saveShots = [null, null];
  #saveWrites = [0, 0];
  #fpsFrames = 0;
  #fpsSince = 0;

  /**
   * @param {{
   *   display: import('../video/display.js').Display,
   *   audio: import('../audio/audio-output.js').AudioOutput,
   *   input: import('../input/input-manager.js').InputManager,
   *   motion?: import('../input/motion.js').MotionInput,
   *   camera?: import('../input/camera.js').CameraInput,
   *   rumble?: import('../input/rumble.js').Rumble,
   * }} deps  motion/camera/rumble serve cartridges with a tilt sensor, camera or motor.
   */
  constructor({ display, audio, input, motion, camera, rumble }) {
    super();
    this.#display = display;
    this.#audio = audio;
    this.#input = input;
    this.#motion = motion;
    this.#camera = camera;
    this.#rumble = rumble;
    setInterval(() => this.flushSave(), SAVE_CHECK_INTERVAL);
    document.addEventListener('visibilitychange', () => document.hidden && this.flushSave());
    window.addEventListener('pagehide', () => this.flushSave());
  }

  start() {
    requestAnimationFrame(this.#tick);
  }

  /** User options for cores (palettes etc.): applied now and to cores created later. */
  configure(options) {
    this.#coreOptions = options;
    this.core?.configure?.(options);
  }

  /**
   * Starts a ROM from the library.
   * @param {string} key
   * @param {{ saveId?: number | null, snapshotId?: number | null }} [options]
   */
  async launch(key, options) {
    const [rom, data] = await Promise.all([getRom(key), getRomData(key)]);
    if (!rom || !data) throw new Error('This ROM is no longer in the library.');
    await this.play(rom, data, options);
  }

  /**
   * Starts a ROM. Boots with the given saved game (none = new game), or
   * resumes a snapshot, which brings back the saved game it was taken with.
   *
   * @param {{ key: string, name: string, info: import('../rom/detect.js').RomInfo, size: number }} rom
   * @param {Uint8Array} data
   * @param {{ saveId?: number | null, snapshotId?: number | null }} [options]
   */
  async play(rom, data, { saveId = null, snapshotId = null } = {}) {
    const { core, fallback } = await createCore(data, rom.info, this.#coreOptions);
    let state = null;
    if (snapshotId !== null) {
      const snapshot = await getSnapshot(snapshotId);
      checkSnapshot(snapshot, rom.key, core);
      state = snapshot.state;
      saveId = snapshot.saveId ?? null;
    }
    const save = saveId !== null ? await getSave(saveId) : null;

    await this.#unload();
    if (save) core.loadSaveData(save.data);
    if (state) core.loadState(state);
    this.core = core;
    this.rom = { key: rom.key, name: rom.name, info: rom.info, size: rom.size };
    this.saveId = save?.id ?? null;
    this.#lastSave = core.getSaveData()?.slice() ?? null;
    this.#watchSaves(core, true);
    this.#frameDebt = 0;
    this.#display.setSourceSize(core.width, core.height);
    this.#display.draw(core.getFrameBuffer());
    this.setPaused(false);
    touchRom(rom.key).catch(() => {});
    this.emit('loaded', { rom: this.rom, fallback });
    this.#startPeripherals(core);
  }

  #startPeripherals(core) {
    this.#motion?.setActive(Boolean(core.wantsTilt));
    if (core.wantsCamera && this.#camera) {
      const { width, height } = core.cameraSize;
      this.#camera.start(width, height).then((ok) => {
        if (!ok && this.core === core) {
          this.emit('status', { text: 'No camera available: the Game Boy Camera shows a test image.', error: true });
        }
      });
    }
  }

  /** Stops the running game (after storing its save). */
  async stop() {
    if (!this.core) return;
    await this.#unload();
    this.emit('stopped');
  }

  async #unload() {
    if (!this.core) return;
    await this.flushSave();
    this.player2 = null;
    this.#lastSave2 = null;
    this.#single = null;
    this.core = null;
    this.rom = null;
    this.saveId = null;
    this.#lastSave = null;
    this.#audio.clear();
    this.#motion?.setActive(false);
    this.#camera?.stop();
    this.#rumble?.set(0);
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

  /** Stores the in-game save if it changed. Calls are queued, never concurrent. */
  flushSave() {
    this.#saveQueue = this.#saveQueue.then(() => this.#writeSave());
    return this.#saveQueue;
  }

  async #writeSave() {
    await this.#writePlayerSave(0);
    if (this.player2) await this.#writePlayerSave(1);
  }

  async #writePlayerSave(player) {
    const { core } = this;
    // Player 1's slot is the emulator itself (rom, saveId); player 2's is player2.
    const slot = player ? this.player2 : this;
    const data = core?.getSaveData(player);
    const last = player ? this.#lastSave2 : this.#lastSave;
    // A screenshot taken at writes that didn't change the save is stale.
    const shot = this.#saveShots[player];
    this.#saveShots[player] = null;
    if (!data || !slot || sameBytes(data, last)) return;
    const copy = data.slice();
    if (player) this.#lastSave2 = copy;
    else this.#lastSave = copy;
    try {
      const thumbnail = await screenshotBlob(shot ?? screenshot(core, player));
      // The saved game may have been deleted while in use: start a new one.
      if (slot.saveId === null || !(await updateSave(slot.saveId, copy, thumbnail))) {
        const id = await createSave(slot.rom.key, copy, undefined, thumbnail);
        if (this.core === core) slot.saveId = id;
        this.emit('status', { text: player ? 'Started a new saved game for player 2.' : 'Started a new saved game.' });
      }
    } catch (err) {
      this.emit('status', { text: `Could not store the saved game: ${err.message}`, error: true });
    }
  }

  /** Whether a second game can be linked to the running one. */
  canLink(info) {
    return !this.player2 && canLink(this.core, info);
  }

  /**
   * Connects a second game from the library with a link cable, as player 2.
   * The running game carries on.
   * @param {string} key
   * @param {{ saveId?: number | null, vertical?: boolean }} [options] Player 2's saved game; screen layout.
   */
  async link(key, { saveId = null, vertical = false } = {}) {
    const [rom, data] = await Promise.all([getRom(key), getRomData(key)]);
    if (!rom || !data) throw new Error('This ROM is no longer in the library.');
    if (!this.canLink(rom.info)) throw new Error('Only Game Boy and Game Boy Color games can be linked.');
    const save = saveId !== null ? await getSave(saveId) : null;
    const single = this.core;
    const linked = await createLinkedCore(single, data, rom.info, this.#coreOptions, { vertical });
    if (save) linked.loadSaveData(save.data, 1);
    if (this.core !== single) return;
    this.#single = single;
    this.core = linked;
    this.player2 = { rom: { key: rom.key, name: rom.name, info: rom.info, size: rom.size }, saveId: save?.id ?? null };
    this.#lastSave2 = linked.getSaveData(1)?.slice() ?? null;
    this.#watchSaves(linked, true);
    this.#display.setSourceSize(linked.width, linked.height);
    this.#audio.clear();
    this.emit('linked', this.player2.rom);
  }

  /** Disconnects player 2 (after storing its save); player 1 keeps playing. */
  async unlink() {
    if (!this.player2) return;
    await this.flushSave();
    this.core.unlink();
    this.core = this.#single;
    this.#single = null;
    this.player2 = null;
    this.#lastSave2 = null;
    this.#watchSaves(this.core, true);
    this.#display.setSourceSize(this.core.width, this.core.height);
    this.#display.draw(this.core.getFrameBuffer());
    this.#audio.clear();
    this.emit('unlinked');
  }

  async takeSnapshot() {
    const { core, rom } = this;
    if (!core) return;
    if (this.player2) throw new Error('Snapshots are not available while two games are linked.');
    // The state and screen of this moment, before anything async.
    const state = core.saveState();
    const shot = screenshot(core);
    await this.flushSave();
    const thumbnail = await screenshotBlob(shot);
    await addSnapshot({
      romKey: rom.key,
      coreId: core.id,
      coreVersion: core.version,
      saveId: this.saveId,
      created: Date.now(),
      thumbnail,
      state,
    });
    this.emit('snapshots');
    this.emit('status', { text: 'Snapshot saved.' });
  }

  /** Restores a snapshot of the running game in place. */
  async loadSnapshot(id) {
    const { core, rom } = this;
    if (!core) return;
    if (this.player2) throw new Error('Disconnect the link cable to load a snapshot.');
    const snapshot = await getSnapshot(id);
    checkSnapshot(snapshot, rom.key, core);
    const save = snapshot.saveId != null ? await getSave(snapshot.saveId) : null;
    await this.flushSave();
    core.loadState(snapshot.state);
    this.saveId = save?.id ?? null;
    this.#lastSave = core.getSaveData()?.slice() ?? null;
    this.#watchSaves(core, true);
    this.#audio.clear();
    this.#display.draw(core.getFrameBuffer());
    this.emit('status', { text: 'Snapshot loaded.' });
  }

  async loadLatestSnapshot() {
    if (!this.core) return;
    const [latest] = await listSnapshots(this.rom.key);
    if (!latest) throw new Error('No snapshots for this game yet.');
    await this.loadSnapshot(latest.id);
  }

  /**
   * Screenshots the first frame in which the game writes its save memory
   * (the save screen), for the saved game's thumbnail. `reset` starts over
   * with a new core or state.
   */
  #watchSaves(core, reset = false) {
    if (!core.getSaveWrites) return;
    for (let player = 0; player < (core.players ?? 1); player++) {
      const writes = core.getSaveWrites(player);
      if (reset) this.#saveShots[player] = null;
      else if (writes !== this.#saveWrites[player] && !this.#saveShots[player]) {
        this.#saveShots[player] = screenshot(core, player);
      }
      this.#saveWrites[player] = writes;
    }
  }

  #tick = (now) => {
    requestAnimationFrame(this.#tick);
    const elapsed = Math.min(now - this.#lastTime, MAX_TICK_GAP);
    this.#lastTime = now;
    const players = this.core?.players ?? 1;
    const input = this.#input.poll(players);
    const { core } = this;
    if (!core || this.paused) {
      this.#pendingButtons = 0;
      this.#rumble?.set(0, now);
      return;
    }

    const speed = input.fastForward ? Math.max(FAST_FORWARD_SPEED, this.speed) : this.speed;
    this.#frameDebt += (elapsed / 1000) * core.fps * speed;
    let frames = Math.floor(this.#frameDebt);
    if (frames > MAX_FRAMES_PER_TICK) {
      frames = MAX_FRAMES_PER_TICK;
      this.#frameDebt = 0;
    } else {
      this.#frameDebt -= frames;
    }

    this.#pendingButtons |= players > 1 ? input.buttons | (input.buttons2 << 16) : input.buttons | input.buttons2;
    if (frames) {
      core.setInput(this.#pendingButtons);
      this.#pendingButtons = 0;
      if (core.wantsTilt) core.setTilt(input.tiltX ?? 0, input.tiltY ?? 0);
      if (core.wantsCamera) {
        const image = this.#camera?.frame(now);
        if (image) core.setCameraImage(image);
      }
    }
    for (let i = 0; i < frames; i++) {
      core.runFrame();
      this.#audio.push(core.getAudioSamples(), core.sampleRate);
    }
    this.#audio.flush();
    if (frames) {
      this.#watchSaves(core);
      this.#display.draw(core.getFrameBuffer());
      this.#rumble?.set(core.getRumble?.() ?? 0, now);
    }

    this.#fpsFrames += frames;
    if (now - this.#fpsSince >= 500) {
      this.emit('fps', (this.#fpsFrames * 1000) / (now - this.#fpsSince));
      this.#fpsFrames = 0;
      this.#fpsSince = now;
    }
  };
}

function checkSnapshot(snapshot, romKey, core) {
  if (!snapshot || snapshot.romKey !== romKey) throw new Error('Snapshot not found for this game.');
  if (snapshot.coreId !== core.id || snapshot.coreVersion !== core.version) {
    throw new Error('This snapshot was made with a different emulator core version.');
  }
}

/** A copy of a player's screen. */
function screenshot(core, player = 0) {
  return core.screenshot?.(player) ?? { pixels: core.getFrameBuffer().slice(), width: core.width, height: core.height };
}

/** @returns {Promise<Blob | null>} */
async function screenshotBlob(shot) {
  try {
    return await frameToBlob(shot.pixels, shot.width, shot.height);
  } catch {
    return null;
  }
}

function sameBytes(a, b) {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
