import { saveSettings } from '../app/settings.js';
import { loadRomFile } from '../rom/loader.js';
import { addRom, listRoms } from '../storage/roms.js';
import { listSaves } from '../storage/saves.js';
import { listSnapshots } from '../storage/snapshots.js';
import { FILTERS } from '../video/filters.js';
import { baseName, formatSize, pickFiles, SYSTEM_NAMES } from './dom.js';
import { ROM_ACCEPT, SAVE_EXTENSION } from './files.js';
import { createGameDialog } from './game-dialog.js';
import { createLibraryDialog } from './library-dialog.js';
import { createModals } from './modals.js';

const FLASH_DURATION = 4000;

const $ = (id) => document.getElementById(id);

/**
 * Wires the page (toolbar, drag-and-drop, status bar, dialogs) to the
 * emulator. Returns the hotkey handler used by the keyboard.
 */
export function setupUI({ emulator, display, audio, inputs, settings }) {
  const el = {
    toolbar: $('toolbar'),
    open: $('open'),
    library: $('library-open'),
    pause: $('pause'),
    reset: $('reset'),
    snapshot: $('snapshot'),
    saves: $('saves-open'),
    speed: $('speed'),
    filter: $('filter'),
    dedither: $('dedither'),
    zoom: $('zoom'),
    volume: $('volume'),
    fullscreen: $('fullscreen'),
    stage: $('stage'),
    status: $('status'),
    fps: $('fps'),
  };
  const gameControls = [el.pause, el.reset, el.snapshot, el.saves];

  // --- Status bar --------------------------------------------------------
  let romStatus = 'No ROM loaded.';
  let flashTimer = 0;

  function showRomStatus() {
    clearTimeout(flashTimer);
    const hint = emulator.core && audio.blocked ? ' · tap or press a key to enable sound' : '';
    setStatus(romStatus + hint);
  }

  function setStatus(text, error = false) {
    el.status.textContent = text;
    el.status.classList.toggle('error', error);
  }

  /** Shows a message briefly, then returns to the ROM status. */
  function flash(text, error = false) {
    setStatus(text, error);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(showRomStatus, FLASH_DURATION);
  }

  const reportError = (err) => {
    console.error(err);
    flash(err.message ?? String(err), true);
  };

  const updateSettings = (patch) => {
    Object.assign(settings, patch);
    saveSettings(settings);
  };

  // --- Dialogs -----------------------------------------------------------
  const modals = createModals({ emulator, inputs });
  const gameDialog = createGameDialog({
    dialog: $('game'),
    modals,
    emulator,
    onError: reportError,
    onStatus: flash,
  });
  const library = createLibraryDialog({
    dialog: $('library'),
    modals,
    emulator,
    onPlay: (key) => selectRom(key).catch(reportError),
    onAdd: (files) => addRoms(files).then(reportAdded),
    onError: reportError,
  });

  // --- ROMs and saved-game files -----------------------------------------

  /** Offers saved games and snapshots when there are any; otherwise starts a new game. */
  async function selectRom(key) {
    audio.init();
    const [saves, snapshots] = await Promise.all([listSaves(key), listSnapshots(key)]);
    if (saves.length || snapshots.length) await gameDialog.open(key);
    else await emulator.launch(key);
  }

  /**
   * Adds ROM files to the library.
   * @returns {Promise<{ added: import('../rom/loader.js').LoadedRom[], unstored: import('../rom/loader.js').LoadedRom[], errors: string[] }>}
   */
  async function addRoms(files) {
    const result = { added: [], unstored: [], errors: [] };
    for (const file of files) {
      setStatus(`Loading ${file.name}…`);
      let rom;
      try {
        rom = await loadRomFile(file);
      } catch (err) {
        result.errors.push(`${file.name}: ${err.message}`);
        continue;
      }
      try {
        await addRom(rom);
        result.added.push(rom);
      } catch (err) {
        console.error(err);
        result.unstored.push(rom);
        result.errors.push(`${file.name} could not be stored: ${err.message}`);
      }
    }
    return result;
  }

  function reportAdded({ added, errors }) {
    if (errors.length) flash(errors.join(' · '), true);
    else if (added.length) flash(`Added ${added.length} ROM${added.length === 1 ? '' : 's'} to the library.`);
    else showRomStatus();
  }

  /** Handles files from Open ROM or drag-and-drop: ROMs, zips and saved games. */
  async function openFiles(files) {
    audio.init();
    const saveFiles = files.filter((file) => SAVE_EXTENSION.test(file.name));
    const romFiles = files.filter((file) => !SAVE_EXTENSION.test(file.name));
    try {
      if (saveFiles.length) {
        if (!emulator.rom) throw new Error('Start a game first, then add its saved game.');
        await gameDialog.importSaves(emulator.rom.key, saveFiles);
      }
      if (!romFiles.length) return;

      const result = await addRoms(romFiles);
      reportAdded(result);
      const [rom] = result.added;
      if (result.added.length === 1 && result.unstored.length === 0) {
        await selectRom(rom.key);
      } else if (result.added.length > 1) {
        await library.open();
      } else if (result.unstored.length === 1 && result.added.length === 0) {
        // Storage full or unavailable: still let the ROM be played.
        const [unstored] = result.unstored;
        await emulator.play(unstored, unstored.data);
        flash(`${unstored.name} is running but could not be added to the library.`, true);
      }
    } catch (err) {
      reportError(err);
    }
  }

  el.open.addEventListener('click', async () => {
    const files = await pickFiles({ accept: `${ROM_ACCEPT},.sav,.srm`, multiple: true });
    if (files.length) openFiles(files);
  });

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer?.types.includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    // Close open dialogs so the dropped game isn't hidden behind them.
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    openFiles(files);
  });

  // --- Toolbar -----------------------------------------------------------
  el.library.addEventListener('click', () => library.open().catch(reportError));
  el.pause.addEventListener('click', () => emulator.setPaused(!emulator.paused));
  el.reset.addEventListener('click', () => emulator.reset());
  el.snapshot.addEventListener('click', () => emulator.takeSnapshot().catch(reportError));
  el.saves.addEventListener('click', () => emulator.rom && gameDialog.open(emulator.rom.key).catch(reportError));
  el.fullscreen.addEventListener('click', () => display.toggleFullscreen());
  el.fullscreen.hidden = !document.fullscreenEnabled;

  el.speed.addEventListener('change', () => (emulator.speed = Number(el.speed.value)));

  el.filter.append(...FILTERS.map((filter) => new Option(filter.name, filter.id)));
  el.filter.value = settings.filter;
  display.setFilter(settings.filter);
  el.filter.addEventListener('change', () => {
    display.setFilter(el.filter.value);
    updateSettings({ filter: el.filter.value });
  });

  el.dedither.checked = settings.dedither;
  el.dedither.disabled = !display.supportsShaders;
  display.setDedither(settings.dedither);
  el.dedither.addEventListener('change', () => {
    display.setDedither(el.dedither.checked);
    updateSettings({ dedither: el.dedither.checked });
  });

  el.zoom.value = String(settings.zoom);
  display.setZoom(settings.zoom === 'fit' ? 'fit' : Number(settings.zoom));
  el.zoom.addEventListener('change', () => {
    const zoom = el.zoom.value === 'fit' ? 'fit' : Number(el.zoom.value);
    display.setZoom(zoom);
    updateSettings({ zoom });
  });

  el.volume.value = String(Math.round(settings.volume * 100));
  audio.setVolume(settings.volume);
  el.volume.addEventListener('input', () => audio.setVolume(Number(el.volume.value) / 100));
  el.volume.addEventListener('change', () => updateSettings({ volume: Number(el.volume.value) / 100 }));

  // Hand focus back to the page so game keys don't operate the toolbar.
  el.toolbar.addEventListener('change', (e) => e.target.blur());
  el.toolbar.addEventListener('click', (e) => e.target.closest('button')?.blur());

  // --- Emulator and device events ----------------------------------------
  emulator.on('loaded', ({ rom, fallback }) => {
    document.body.dataset.system = rom.info.system;
    el.stage.classList.remove('empty');
    gameControls.forEach((control) => (control.disabled = false));
    const title = rom.info.title || baseName(rom.name);
    romStatus = `${SYSTEM_NAMES[rom.info.system]} · ${title} · ${formatSize(rom.size)}`;
    if (fallback) romStatus += ' · no emulator core for this system yet, running the test core';
    showRomStatus();
  });
  emulator.on('stopped', () => {
    delete document.body.dataset.system;
    el.stage.classList.add('empty');
    gameControls.forEach((control) => (control.disabled = true));
    el.fps.textContent = '';
    romStatus = 'No ROM loaded.';
    showRomStatus();
  });
  emulator.on('paused', (paused) => {
    el.pause.textContent = paused ? 'Resume' : 'Pause';
    if (paused && emulator.core) el.fps.textContent = 'Paused';
  });
  emulator.on('fps', (fps) => (el.fps.textContent = `${fps.toFixed(1)} fps`));
  emulator.on('status', ({ text, error }) => flash(text, error));
  audio.on('state', () => {
    if (el.status.textContent.startsWith(romStatus)) showRomStatus();
  });
  window.addEventListener('gamepadconnected', (e) => flash(`Controller connected: ${e.gamepad.id}`));
  window.addEventListener('gamepaddisconnected', () => flash('Controller disconnected.'));

  showRomStatus();

  // Start on the library when it has games.
  listRoms()
    .then((roms) => roms.length && !emulator.core && library.open())
    .catch(reportError);

  const hotkeys = {
    pause: () => emulator.core && emulator.setPaused(!emulator.paused),
    fullscreen: () => display.toggleFullscreen(),
    snapshot: () => emulator.takeSnapshot().catch(reportError),
    loadSnapshot: () => emulator.loadLatestSnapshot().catch(reportError),
  };
  return { hotkey: (name) => hotkeys[name]?.() };
}
