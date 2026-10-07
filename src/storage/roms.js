import { requestPersistence, transaction } from "./db.js";

/**
 * The ROM library.
 *
 * @typedef {object} RomEntry
 * @property {string} key                    See loader.js; also keys saves and snapshots.
 * @property {string} name                 Original file name.
 * @property {import('../rom/detect.js').RomInfo} info
 * @property {number} size
 * @property {number} added                Timestamp in ms.
 * @property {number | null} lastPlayed
 */

/** Adds a ROM, or refreshes it if it is already in the library. */
export async function addRom({ key, name, info, data }) {
    await transaction(["roms", "romData"], "readwrite", (tx) => {
        const roms = tx.objectStore("roms");
        const existing = roms.get(key);
        existing.onsuccess = () => {
            roms.put({
                key,
                name,
                info,
                size: data.length,
                added: existing.result?.added ?? Date.now(),
                lastPlayed: existing.result?.lastPlayed ?? null,
            });
        };
        tx.objectStore("romData").put({ key, data });
    });
    requestPersistence();
}

/** @returns {Promise<RomEntry[]>} Most recently played (or added) first. */
export async function listRoms() {
    const roms = await transaction("roms", "readonly", (tx) => {
        const request = tx.objectStore("roms").getAll();
        return () => request.result;
    });
    const recency = (rom) => rom.lastPlayed ?? rom.added;
    return roms.sort((a, b) => recency(b) - recency(a));
}

/** @returns {Promise<RomEntry | null>} */
export function getRom(key) {
    return transaction("roms", "readonly", (tx) => {
        const request = tx.objectStore("roms").get(key);
        return () => request.result ?? null;
    });
}

/** @returns {Promise<Uint8Array | null>} */
export function getRomData(key) {
    return transaction("romData", "readonly", (tx) => {
        const request = tx.objectStore("romData").get(key);
        return () => request.result?.data ?? null;
    });
}

export function touchRom(key) {
    return transaction("roms", "readwrite", (tx) => {
        const roms = tx.objectStore("roms");
        const request = roms.get(key);
        request.onsuccess = () => request.result && roms.put({ ...request.result, lastPlayed: Date.now() });
    });
}

/** Deletes a ROM together with its saved games and snapshots. */
export function deleteRom(key) {
    const stores = ["roms", "romData", "saves", "snapshots", "snapshotStates"];
    return transaction(stores, "readwrite", (tx) => {
        tx.objectStore("roms").delete(key);
        tx.objectStore("romData").delete(key);
        const states = tx.objectStore("snapshotStates");
        for (const store of ["saves", "snapshots"]) {
            tx.objectStore(store).index("romKey").openCursor(key).onsuccess = (event) => {
                const cursor = event.target.result;
                if (!cursor) return;
                if (store === "snapshots") states.delete(cursor.primaryKey);
                cursor.delete();
                cursor.continue();
            };
        }
    });
}
