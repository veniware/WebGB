// IndexedDB access. Used instead of localStorage because ROMs and save
// states are large (up to 32 MB and hundreds of KB) and localStorage is
// limited to ~5 MB.

const DB_NAME = "webgb";
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
    dbPromise ??= new Promise((resolve, reject) => {
        if (!globalThis.indexedDB) {
            reject(new Error("This browser does not support local storage (IndexedDB)."));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const db = request.result;
            if (event.oldVersion < 1) {
                // ROM metadata and ROM bytes are split so listing the library stays cheap.
                db.createObjectStore("roms", { keyPath: "key" });
                db.createObjectStore("romData", { keyPath: "key" });
                const saves = db.createObjectStore("saves", { keyPath: "id", autoIncrement: true });
                saves.createIndex("romKey", "romKey");
                const snapshots = db.createObjectStore("snapshots", { keyPath: "id", autoIncrement: true });
                snapshots.createIndex("romKey", "romKey");
                db.createObjectStore("snapshotStates", { keyPath: "id" });
            }
            if (event.oldVersion < 2) {
                // Files that aren't games, e.g. a GBA BIOS.
                db.createObjectStore("files", { keyPath: "name" });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            // Let a newer version of the page (in another tab) upgrade the database.
            db.onversionchange = () => {
                db.close();
                dbPromise = null;
            };
            resolve(db);
        };
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
        tx.oncomplete = () => resolve(typeof result === "function" ? result() : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("Storage transaction aborted."));
    });
}

let persistenceRequested = false;

/** Asks the browser not to evict our data under storage pressure. */
export function requestPersistence() {
    if (persistenceRequested) return;
    persistenceRequested = true;
    navigator.storage?.persist?.().catch(() => {});
}
