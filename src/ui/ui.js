import { saveSettings } from '../app/settings.js';
import { FILTERS } from '../video/filters.js';
import { createSnapshotsPanel } from './snapshots-panel.js';

const SYSTEM_NAMES = { gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance' };
const FLASH_DURATION = 4000;

const $ = (id) => document.getElementById(id);

/**
 * Wires the page (toolbar, drag-and-drop, status bar, snapshot dialog) to
 * the emulator. Returns the hotkey handler used by the keyboard.
 */
export function setupUI({ emulator, display, audio, inputs, settings }) {
  const el = {
    toolbar: $('toolbar'),
    open: $('open'),
    file: $('file'),
    pause: $('pause'),
    reset: $('reset'),
    snapshot: $('snapshot'),
    snapshots: $('snapshots-open'),
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
  const gameControls = [el.pause, el.reset, el.snapshot, el.snapshots];

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

  // --- ROM loading -------------------------------------------------------
  async function openRom(file) {
    audio.init();
    setStatus(`Loading ${file.name}…`);
    try {
      await emulator.load(file);
    } catch (err) {
      reportError(err);
    }
  }

  el.open.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    const [file] = el.file.files;
    el.file.value = '';
    if (file) openRom(file);
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
    const [file] = e.dataTransfer?.files ?? [];
    if (file) openRom(file);
  });

  // --- Toolbar -----------------------------------------------------------
  const setInputsEnabled = (enabled) => inputs.forEach((input) => (input.enabled = enabled));
  const snapshotsPanel = createSnapshotsPanel({
    dialog: $('snapshots'),
    emulator,
    onError: reportError,
    onOpenChange: (open) => setInputsEnabled(!open),
  });

  el.pause.addEventListener('click', () => emulator.setPaused(!emulator.paused));
  el.reset.addEventListener('click', () => emulator.reset());
  el.snapshot.addEventListener('click', () => emulator.takeSnapshot().catch(reportError));
  el.snapshots.addEventListener('click', () => snapshotsPanel.open());
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
    el.stage.classList.remove('empty');
    gameControls.forEach((control) => (control.disabled = false));
    const title = rom.info.title || rom.name;
    romStatus = `${SYSTEM_NAMES[rom.info.system]} · ${title} · ${formatSize(rom.data.length)}`;
    if (fallback) romStatus += ' · core not implemented yet, running the test core';
    showRomStatus();
  });
  emulator.on('paused', (paused) => {
    el.pause.textContent = paused ? 'Resume' : 'Pause';
    if (paused) el.fps.textContent = 'Paused';
  });
  emulator.on('fps', (fps) => (el.fps.textContent = `${fps.toFixed(1)} fps`));
  emulator.on('status', ({ text, error }) => flash(text, error));
  audio.on('state', () => {
    if (el.status.textContent.startsWith(romStatus)) showRomStatus();
  });
  window.addEventListener('gamepadconnected', (e) => flash(`Controller connected: ${e.gamepad.id}`));
  window.addEventListener('gamepaddisconnected', () => flash('Controller disconnected.'));

  showRomStatus();

  const hotkeys = {
    pause: () => emulator.core && emulator.setPaused(!emulator.paused),
    fullscreen: () => display.toggleFullscreen(),
    snapshot: () => emulator.takeSnapshot().catch(reportError),
    loadSnapshot: () => emulator.loadLatestSnapshot().catch(reportError),
  };
  return { hotkey: (name) => hotkeys[name]?.() };
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}
