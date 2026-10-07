import { listRoms } from "../storage/roms.js";
import { listSaves } from "../storage/saves.js";
import { baseName, h, SYSTEM_SHORT } from "./dom.js";

/**
 * Picks player 2's game (and saved game) for the link cable.
 *
 * @param {{
 *     dialog: HTMLDialogElement,
 *     modals: ReturnType<typeof import("./modals.js").createModals>,
 *     emulator: import("../app/emulator.js").Emulator,
 *     onError: (err: Error) => void,
 * }} deps
 */
export function createLinkDialog({ dialog, modals, emulator, onError }) {
    const list = dialog.querySelector("[data-list]");
    const empty = dialog.querySelector("[data-empty]");

    async function render() {
        const roms = (await listRoms()).filter((rom) => emulator.canLink(rom.info));
        const rows = await Promise.all(roms.map(async (rom) => romRow(rom, await listSaves(rom.key))));
        if (emulator.canLinkCartless()) rows.unshift(cartlessRow());
        list.replaceChildren(...rows);
        empty.hidden = rows.length > 0;
    }

    /** A GBA without a cartridge: games that support it send it what it runs (multiboot). */
    function cartlessRow() {
        return h(
            "li",
            {},
            h("span", { className: "badge", textContent: SYSTEM_SHORT.gba }),
            h(
                "div",
                { className: "grow" },
                h("strong", { textContent: "No cartridge" }),
                h("small", { textContent: "For games with single-cartridge multiplayer: player 2 gets the game over the cable." }),
            ),
            h("div", { className: "actions" }, h("button", { type: "button", textContent: "Connect", onclick: () => link(null, null) })),
        );
    }

    function romRow(rom, saves) {
        const choice = (label, saveId) => h("button", { type: "button", textContent: label, onclick: () => link(rom, saveId) });
        return h(
            "li",
            {},
            h("span", { className: "badge", textContent: SYSTEM_SHORT[rom.info.system] }),
            h("div", { className: "grow" }, h("strong", { textContent: rom.info.title || baseName(rom.name) })),
            h("div", { className: "actions" }, choice("New game", null), saves.map((save) => choice(save.name, save.id))),
        );
    }

    /** @param {{ key: string } | null} rom  null: no cartridge. */
    async function link(rom, saveId) {
        try {
            // Portrait screens stack the two games.
            const vertical = window.innerHeight > window.innerWidth;
            await emulator.link(rom?.key ?? null, { saveId, vertical });
            dialog.close();
        } catch (err) {
            onError(err);
        }
    }

    dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

    return {
        async open() {
            await render();
            modals.show(dialog);
        },
    };
}
