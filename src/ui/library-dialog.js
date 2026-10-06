import { deleteRom, getRomData, listRoms } from '../storage/roms.js';
import { listSaves } from '../storage/saves.js';
import { listSnapshots } from '../storage/snapshots.js';
import { baseName, downloadFile, formatDate, formatSize, h, pickFiles, SYSTEM_SHORT } from './dom.js';
import { ROM_ACCEPT } from './files.js';

/**
 * The ROM library: browse, play, export and delete ROMs.
 *
 * @param {{
 *   dialog: HTMLDialogElement,
 *   modals: ReturnType<typeof import('./modals.js').createModals>,
 *   emulator: import('../app/emulator.js').Emulator,
 *   onPlay: (key: string) => void,
 *   onAdd: (files: File[]) => Promise<void>,
 *   onError: (err: Error) => void,
 * }} deps
 */
export function createLibraryDialog({ dialog, modals, emulator, onPlay, onAdd, onError }) {
  const list = dialog.querySelector('[data-list]');
  const empty = dialog.querySelector('[data-empty]');
  const usage = dialog.querySelector('[data-usage]');

  async function render() {
    const roms = await listRoms();
    list.replaceChildren(...roms.map(romRow));
    empty.hidden = roms.length > 0;
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    usage.textContent = estimate ? `Storage used: ${formatSize(estimate.usage ?? 0)}` : '';
  }

  function romRow(rom) {
    const played = rom.lastPlayed ? `played ${formatDate(rom.lastPlayed)}` : 'never played';
    return h(
      'li',
      {},
      h('span', { className: 'badge', textContent: SYSTEM_SHORT[rom.info.system] }),
      h(
        'div',
        { className: 'grow' },
        h('strong', { textContent: rom.info.title || baseName(rom.name) }),
        h('small', { textContent: `${rom.name} · ${formatSize(rom.size)} · ${played}` }),
      ),
      h(
        'div',
        { className: 'actions' },
        h('button', { type: 'button', textContent: 'Play', onclick: () => play(rom) }),
        h('button', { type: 'button', textContent: 'Export', onclick: () => exportRom(rom).catch(onError) }),
        h('button', { type: 'button', textContent: 'Delete', onclick: () => remove(rom).catch(onError) }),
      ),
    );
  }

  function play(rom) {
    dialog.close();
    onPlay(rom.key);
  }

  async function exportRom(rom) {
    const data = await getRomData(rom.key);
    if (!data) throw new Error('ROM data is missing.');
    downloadFile(data, rom.name);
  }

  async function remove(rom) {
    const [saves, snapshots] = await Promise.all([listSaves(rom.key), listSnapshots(rom.key)]);
    const title = rom.info.title || baseName(rom.name);
    let message = `Delete "${title}" from the library?`;
    if (saves.length || snapshots.length) {
      message += `\n\nThis also deletes its ${saves.length} saved game(s) and ${snapshots.length} snapshot(s). Export saved games first to keep them.`;
    }
    if (!confirm(message)) return;
    if (emulator.rom?.key === rom.key) await emulator.stop();
    await deleteRom(rom.key);
    await render();
  }

  dialog.querySelector('[data-add]').addEventListener('click', async () => {
    const files = await pickFiles({ accept: ROM_ACCEPT, multiple: true });
    if (!files.length) return;
    await onAdd(files);
    await render().catch(onError);
  });
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  return {
    async open() {
      await render();
      modals.show(dialog);
    },
  };
}
