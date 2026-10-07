import { getRom } from "../storage/roms.js";
import { createSave, deleteSave, listSaves } from "../storage/saves.js";
import { deleteSnapshot, listSnapshots } from "../storage/snapshots.js";
import { baseName, downloadFile, formatDate, formatSize, h, pickFiles } from "./dom.js";
import { MAX_SAVE_SIZE, SAVE_ACCEPT } from "./files.js";

/**
 * Per-game dialog: start a new game, continue a saved game or resume a
 * snapshot; import, export and delete saved games; take and delete snapshots.
 *
 * @param {{
 *     dialog: HTMLDialogElement,
 *     modals: ReturnType<typeof import('./modals.js').createModals>,
 *     emulator: import('../app/emulator.js').Emulator,
 *     onError: (err: Error) => void,
 *     onStatus: (text: string) => void,
 *     onLink: () => void,
 * }} deps
 */
export function createGameDialog({ dialog, modals, emulator, onError, onStatus, onLink }) {
    const $ = (selector) => dialog.querySelector(selector);
    const title = $("[data-title]");
    const savesList = $("[data-saves]");
    const savesEmpty = $("[data-saves-empty]");
    const snapshotsList = $("[data-snapshots]");
    const snapshotsEmpty = $("[data-snapshots-empty]");
    const takeButton = $("[data-take]");
    const linkSection = $("[data-link-section]");
    const linkButton = $("[data-link]");
    const unlinkButton = $("[data-unlink]");
    const linkStatus = $("[data-link-status]");
    let rom = null;
    let thumbnailUrls = [];

    const isRunning = () => emulator.rom?.key === rom?.key;

    async function render() {
        rom = await getRom(rom.key);
        if (!rom) {
            dialog.close();
            return;
        }
        const [saves, snapshots] = await Promise.all([listSaves(rom.key), listSnapshots(rom.key)]);
        title.textContent = rom.info.title || baseName(rom.name);
        takeButton.hidden = !isRunning() || Boolean(emulator.player2);
        const partner = emulator.player2;
        linkSection.hidden = !isRunning() || (!partner && !emulator.canLink(rom.info));
        linkButton.hidden = Boolean(partner);
        unlinkButton.hidden = !partner;
        linkStatus.textContent = partner
            ? `Linked with ${partner.rom.info.title || baseName(partner.rom.name)} (player 2).`
            : "Play with a second game, e.g. to trade or battle.";

        releaseThumbnails();
        savesList.replaceChildren(...saves.map(saveRow));
        savesEmpty.hidden = saves.length > 0;
        snapshotsList.replaceChildren(...snapshots.map(snapshotRow));
        snapshotsEmpty.hidden = snapshots.length > 0;
    }

    function saveRow(save) {
        const inUse = isRunning() && emulator.saveId === save.id;
        return h(
            "li",
            {},
            thumbnail(save.thumbnail),
            h(
                "div",
                { className: "grow" },
                h("strong", { textContent: save.name }, inUse && h("span", { className: "tag", textContent: "in use" })),
                h("small", { textContent: `${formatDate(save.updated)} · ${formatSize(save.data.length)}` }),
            ),
            h(
                "div",
                { className: "actions" },
                h("button", { type: "button", textContent: "Play", onclick: () => start({ saveId: save.id }) }),
                h("button", {
                    type: "button",
                    textContent: "Export",
                    onclick: () => downloadFile(save.data, `${baseName(rom.name)}.sav`),
                }),
                h("button", { type: "button", textContent: "Delete", onclick: () => removeSave(save).catch(onError) }),
            ),
        );
    }

    /** The screen as it was when saved; blank for imported saved games. */
    function thumbnail(blob) {
        const img = h("img", { alt: "" });
        if (blob) {
            img.src = URL.createObjectURL(blob);
            thumbnailUrls.push(img.src);
        }
        return img;
    }

    function snapshotRow(snapshot) {
        return h(
            "li",
            {},
            thumbnail(snapshot.thumbnail),
            h("div", { className: "grow" }, h("small", { textContent: formatDate(snapshot.created) })),
            h(
                "div",
                { className: "actions" },
                h("button", { type: "button", textContent: "Load", onclick: () => loadSnapshot(snapshot.id) }),
                h("button", {
                    type: "button",
                    textContent: "Delete",
                    onclick: () => removeSnapshot(snapshot).catch(onError),
                }),
            ),
        );
    }

    function releaseThumbnails() {
        thumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
        thumbnailUrls = [];
    }

    async function start(options) {
        try {
            await emulator.launch(rom.key, options);
            dialog.close();
        } catch (err) {
            onError(err);
        }
    }

    async function loadSnapshot(id) {
        if (!isRunning()) return start({ snapshotId: id });
        try {
            await emulator.loadSnapshot(id);
            dialog.close();
        } catch (err) {
            onError(err);
        }
    }

    async function removeSave(save) {
        if (!confirm(`Delete the saved game "${save.name}"? Export it first to keep a copy.`)) return;
        await deleteSave(save.id);
        await render();
    }

    async function removeSnapshot(snapshot) {
        if (!confirm("Delete this snapshot?")) return;
        await deleteSnapshot(snapshot.id);
        await render();
    }

    async function importSaves(files) {
        for (const file of files) {
            if (file.size > MAX_SAVE_SIZE) throw new Error(`${file.name} is too large to be a saved game.`);
            await createSave(rom.key, new Uint8Array(await file.arrayBuffer()), baseName(file.name));
        }
        onStatus(`Imported ${files.length} saved game${files.length === 1 ? "" : "s"}.`);
        await render();
    }

    $("[data-new-game]").addEventListener("click", () => start({}));
    $("[data-import]").addEventListener("click", async () => {
        const files = await pickFiles({ accept: SAVE_ACCEPT, multiple: true });
        if (files.length) await importSaves(files).catch(onError);
    });
    takeButton.addEventListener("click", () => emulator.takeSnapshot().then(render).catch(onError));
    linkButton.addEventListener("click", () => {
        dialog.close();
        onLink();
    });
    unlinkButton.addEventListener("click", () => emulator.unlink().then(render).catch(onError));
    $("[data-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", releaseThumbnails);

    return {
        /** Opens the dialog for a ROM in the library. */
        async open(key) {
            rom = { key };
            await render();
            if (rom) modals.show(dialog);
        },
        /** Imports saved-game files for a ROM, then shows its dialog. */
        async importSaves(key, files) {
            rom = { key };
            if (!(await getRom(key))) throw new Error("This game is not in the library.");
            await importSaves(files);
            if (rom) modals.show(dialog);
        },
    };
}
