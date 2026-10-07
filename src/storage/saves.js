import { requestPersistence, transaction } from './db.js';

/**
 * Saved games: battery-backed cartridge memory (the game's own saves). A ROM
 * can have several, e.g. a new game next to an imported .sav file.
 *
 * @typedef {object} SavedGame
 * @property {number} id
 * @property {string} romKey
 * @property {string} name
 * @property {Uint8Array} data
 * @property {number} created     Timestamp in ms.
 * @property {number} updated     Timestamp in ms.
 * @property {Blob | null} [thumbnail]  The screen when the game last saved.
 */

/** @returns {Promise<SavedGame[]>} Most recently updated first. */
export async function listSaves(romKey) {
  const saves = await transaction('saves', 'readonly', (tx) => {
    const request = tx.objectStore('saves').index('romKey').getAll(romKey);
    return () => request.result;
  });
  return saves.sort((a, b) => b.updated - a.updated);
}

/** @returns {Promise<SavedGame | null>} */
export function getSave(id) {
  return transaction('saves', 'readonly', (tx) => {
    const request = tx.objectStore('saves').get(id);
    return () => request.result ?? null;
  });
}

/**
 * @param {string} romKey
 * @param {Uint8Array} data
 * @param {string} [name]  Defaults to the next free "Save N".
 * @param {Blob | null} [thumbnail]
 * @returns {Promise<number>} The new saved game's id.
 */
export async function createSave(romKey, data, name, thumbnail = null) {
  const id = await transaction('saves', 'readwrite', (tx) => {
    const store = tx.objectStore('saves');
    const existing = store.index('romKey').getAll(romKey);
    let request;
    existing.onsuccess = () => {
      const now = Date.now();
      request = store.add({ romKey, name: name ?? nextName(existing.result), data, thumbnail, created: now, updated: now });
    };
    return () => request.result;
  });
  requestPersistence();
  return id;
}

/**
 * @param {Blob | null} [thumbnail]  Keeps the previous one when null.
 * @returns {Promise<boolean>} False when the saved game no longer exists.
 */
export function updateSave(id, data, thumbnail = null) {
  return transaction('saves', 'readwrite', (tx) => {
    const store = tx.objectStore('saves');
    const request = store.get(id);
    let found = false;
    request.onsuccess = () => {
      if (!request.result) return;
      found = true;
      const previous = request.result.thumbnail ?? null;
      store.put({ ...request.result, data, thumbnail: thumbnail ?? previous, updated: Date.now() });
    };
    return () => found;
  });
}

export function deleteSave(id) {
  return transaction('saves', 'readwrite', (tx) => {
    tx.objectStore('saves').delete(id);
  });
}

function nextName(saves) {
  const numbers = saves.map((save) => Number(/^Save (\d+)$/.exec(save.name)?.[1] ?? 0));
  return `Save ${Math.max(0, ...numbers) + 1}`;
}
