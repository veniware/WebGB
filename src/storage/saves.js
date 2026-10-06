import { requestPersistence, transaction } from './db.js';

/** Battery-backed cartridge memory (in-game saves), one record per ROM. */

/** @returns {Promise<Uint8Array | null>} */
export function loadSave(romKey) {
  return transaction('saves', 'readonly', (tx) => {
    const request = tx.objectStore('saves').get(romKey);
    return () => request.result?.data ?? null;
  });
}

export async function storeSave(romKey, data) {
  await transaction('saves', 'readwrite', (tx) => {
    tx.objectStore('saves').put({ romKey, data, updated: Date.now() });
  });
  requestPersistence();
}
