import { transaction } from "./db.js";

// Other files the user gave us, by name (e.g. 'gba-bios').

/** @returns {Promise<Uint8Array | null>} */
export function getFile(name) {
    return transaction("files", "readonly", (tx) => {
        const request = tx.objectStore("files").get(name);
        return () => request.result?.data ?? null;
    });
}

/** @param {string} name    @param {Uint8Array} data */
export function putFile(name, data) {
    return transaction("files", "readwrite", (tx) => {
        tx.objectStore("files").put({ name, data });
    });
}

export function deleteFile(name) {
    return transaction("files", "readwrite", (tx) => {
        tx.objectStore("files").delete(name);
    });
}
