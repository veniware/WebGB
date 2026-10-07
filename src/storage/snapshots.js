import { requestPersistence, transaction } from './db.js';

/**
 * Save states the user can return to.
 *
 * @typedef {object} SnapshotInfo
 * @property {number} id
 * @property {string} romKey
 * @property {string} coreId
 * @property {number} coreVersion
 * @property {number | null} saveId    Saved game in use when the snapshot was taken.
 * @property {number} created            Timestamp in ms.
 * @property {Blob | null} thumbnail
 */

/** @returns {Promise<SnapshotInfo[]>} Newest first. */
export async function listSnapshots(romKey) {
    const list = await transaction('snapshots', 'readonly', (tx) => {
        const request = tx.objectStore('snapshots').index('romKey').getAll(romKey);
        return () => request.result;
    });
    return list.sort((a, b) => b.created - a.created);
}

/**
 * @param {Omit<SnapshotInfo, 'id'> & { state: Uint8Array }} snapshot
 * @returns {Promise<number>} The new snapshot's id.
 */
export async function addSnapshot({ state, ...info }) {
    const id = await transaction(['snapshots', 'snapshotStates'], 'readwrite', (tx) => {
        const request = tx.objectStore('snapshots').add(info);
        request.onsuccess = () => tx.objectStore('snapshotStates').put({ id: request.result, state });
        return () => request.result;
    });
    requestPersistence();
    return id;
}

/** @returns {Promise<(SnapshotInfo & { state: Uint8Array }) | null>} */
export function getSnapshot(id) {
    return transaction(['snapshots', 'snapshotStates'], 'readonly', (tx) => {
        const info = tx.objectStore('snapshots').get(id);
        const state = tx.objectStore('snapshotStates').get(id);
        return () => (info.result && state.result ? { ...info.result, state: state.result.state } : null);
    });
}

export function deleteSnapshot(id) {
    return transaction(['snapshots', 'snapshotStates'], 'readwrite', (tx) => {
        tx.objectStore('snapshots').delete(id);
        tx.objectStore('snapshotStates').delete(id);
    });
}
