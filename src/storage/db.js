// IndexedDB access. Used instead of localStorage because save states are
// large (hundreds of KB for GBA) and localStorage is limited to ~5 MB.

const DB_NAME = 'webgb';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('This browser does not support local storage (IndexedDB).'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (event.oldVersion < 1) {
        db.createObjectStore('saves', { keyPath: 'romKey' });
        const snapshots = db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
        snapshots.createIndex('romKey', 'romKey');
        // Snapshot states live apart from their metadata so listing stays cheap.
        db.createObjectStore('snapshotStates', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

/**
 * Runs `fn` inside a transaction. `fn` may return a function whose value
 * becomes the result once the transaction has committed.
 *
 * @template T
 * @param {string | string[]} storeNames
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => (() => T) | void} fn
 * @returns {Promise<T>}
 */
export async function transaction(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const result = fn(tx);
    tx.oncomplete = () => resolve(typeof result === 'function' ? result() : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Storage transaction aborted.'));
  });
}

let persistenceRequested = false;

/** Asks the browser not to evict our data under storage pressure. */
export function requestPersistence() {
  if (persistenceRequested) return;
  persistenceRequested = true;
  navigator.storage?.persist?.().catch(() => {});
}
