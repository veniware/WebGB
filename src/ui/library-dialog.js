import { exportBackup, importBackup } from '../storage/backup.js';
import { deleteRom, getRomData, listRoms } from '../storage/roms.js';
import { listSaves } from '../storage/saves.js';
import { listSnapshots } from '../storage/snapshots.js';
import { baseName, downloadFile, formatDate, formatSize, h, pickFiles, SYSTEM_SHORT } from './dom.js';
import { BACKUP_ACCEPT, ROM_ACCEPT } from './files.js';

/**
 * The ROM library: browse, play, export and delete ROMs; back up and
 * restore everything (games, saved games, snapshots, settings).
 *
 * @param {{
 *     dialog: HTMLDialogElement,
 *     modals: ReturnType<typeof import('./modals.js').createModals>,
 *     emulator: import('../app/emulator.js').Emulator,
 *     onPlay: (key: string) => void,
 *     onAdd: (files: File[]) => Promise<void>,
 *     onError: (err: Error) => void,
 *     settings: object,
 *     onRestored: (result: Awaited<ReturnType<typeof importBackup>>) => void,
 * }} deps
 */
export function createLibraryDialog({ dialog, modals, emulator, onPlay, onAdd, onError, settings, onRestored }) {
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

    const backupButtons = [dialog.querySelector('[data-backup]'), dialog.querySelector('[data-restore]')];
    /** Runs a backup task with the buttons disabled and `text` shown meanwhile. */
    async function busy(text, task) {
        backupButtons.forEach((button) => (button.disabled = true));
        usage.textContent = text;
        try {
            await task();
        } catch (err) {
            onError(err);
        } finally {
            backupButtons.forEach((button) => (button.disabled = false));
            await render().catch(onError);
        }
    }

    backupButtons[0].addEventListener('click', () => busy('Backing up…', async () => {
        await emulator.flushSave();
        const blob = await exportBackup(settings);
        downloadFile(blob, `webgb-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    }));
    backupButtons[1].addEventListener('click', async () => {
        const [file] = await pickFiles({ accept: BACKUP_ACCEPT });
        if (!file) return;
        await busy('Restoring…', async () => {
            onRestored(await importBackup(new Uint8Array(await file.arrayBuffer())));
        });
    });

    return {
        async open() {
            await render();
            modals.show(dialog);
        },
    };
}
