import { extractZipEntry, isZip, listZip } from "../rom/zip.js";
import { createZip } from "../util/zip-writer.js";
import { requestPersistence, transaction } from "./db.js";

// A backup is a zip: webgb-backup.json describes everything, and ROMs,
// saved games (.sav), snapshot states and thumbnails are files next to it.
const MANIFEST = "webgb-backup.json";
const FORMAT = 1;
const STORES = ["roms", "romData", "saves", "snapshots", "snapshotStates", "files"];

/**
 * The whole library (games, saved games, snapshots, BIOS) and the settings.
 * @param {object} settings
 * @returns {Promise<Blob>}
 */
export async function exportBackup(settings) {
    const all = await transaction(STORES, "readonly", (tx) => {
        const requests = Object.fromEntries(STORES.map((name) => [name, tx.objectStore(name).getAll()]));
        return () => Object.fromEntries(STORES.map((name) => [name, requests[name].result]));
    });
    const files = [];
    const add = (name, data, date) => {
        files.push({ name, data, date });
        return name;
    };
    const romData = new Map(all.romData.map(({ key, data }) => [key, data]));
    const states = new Map(all.snapshotStates.map(({ id, state }) => [id, state]));
    const thumbnail = async (path, blob, date) => (blob ? add(path, new Uint8Array(await blob.arrayBuffer()), date) : null);

    const manifest = {
        format: FORMAT,
        app: "WebGB",
        created: Date.now(),
        settings,
        roms: all.roms.filter((rom) => romData.has(rom.key)).map((rom) => ({
            ...rom,
            file: add(`roms/${rom.key}/${safeName(rom.name)}`, romData.get(rom.key), rom.added),
        })),
        saves: await Promise.all(all.saves.map(async ({ data, thumbnail: shot, ...save }) => ({
            ...save,
            file: add(`saves/${save.romKey}/${save.id} ${safeName(save.name)}.sav`, data, save.updated),
            thumbnail: await thumbnail(`saves/${save.romKey}/${save.id}.png`, shot, save.updated),
        }))),
        snapshots: await Promise.all(all.snapshots.filter((snapshot) => states.has(snapshot.id))
            .map(async ({ thumbnail: shot, ...snapshot }) => ({
                ...snapshot,
                file: add(`snapshots/${snapshot.romKey}/${snapshot.id}.state`, states.get(snapshot.id), snapshot.created),
                thumbnail: await thumbnail(`snapshots/${snapshot.romKey}/${snapshot.id}.png`, shot, snapshot.created),
            }))),
        files: all.files.map(({ name, data }) => ({ name, file: add(`files/${name}`, data) })),
    };
    files.unshift({ name: MANIFEST, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)) });
    return createZip(files);
}

/**
 * Adds a backup's contents to the library: games that aren't in it yet, and
 * saved games and snapshots it doesn't have (restoring twice adds nothing).
 * Stored files (the BIOS) are replaced.
 *
 * @param {Uint8Array} data    The backup zip.
 * @returns {Promise<{ roms: number, saves: number, snapshots: number, settings: object | null }>} What was added.
 */
export async function importBackup(data) {
    if (!isZip(data)) throw new Error("This is not a WebGB backup.");
    const entries = new Map(listZip(data).map((entry) => [entry.name, entry]));
    const read = async (name) => {
        const entry = entries.get(name);
        if (!entry) throw new Error(`The backup is missing ${name}.`);
        return extractZipEntry(data, entry);
    };
    if (!entries.has(MANIFEST)) throw new Error("This is not a WebGB backup.");
    const manifest = JSON.parse(new TextDecoder().decode(await read(MANIFEST)));
    if (manifest.format !== FORMAT) throw new Error("This backup is from another version of WebGB.");
    const image = async (name) => (name ? new Blob([await read(name)], { type: "image/png" }) : null);

    const existing = await transaction(["roms", "saves", "snapshots"], "readonly", (tx) => {
        const roms = tx.objectStore("roms").getAllKeys();
        const saves = tx.objectStore("saves").getAll();
        const snapshots = tx.objectStore("snapshots").getAll();
        return () => ({ roms: new Set(roms.result), saves: saves.result, snapshots: snapshots.result });
    });

    // Everything is read before writing: a transaction can't wait for unzipping.
    const roms = [];
    for (const { file, ...rom } of manifest.roms ?? []) {
        if (!existing.roms.has(rom.key)) roms.push({ rom, data: await read(file) });
    }
    // Backup save id -> library save id (existing or added).
    const saveIds = new Map();
    const saves = [];
    for (const { id, file, thumbnail, ...save } of manifest.saves ?? []) {
        const same = existing.saves.find((s) => s.romKey === save.romKey && s.created === save.created && s.name === save.name);
        if (same) saveIds.set(id, same.id);
        else saves.push({ id, save: { ...save, data: await read(file), thumbnail: await image(thumbnail) } });
    }
    const snapshots = [];
    for (const { id, file, thumbnail, ...snapshot } of manifest.snapshots ?? []) {
        if (existing.snapshots.some((s) => s.romKey === snapshot.romKey && s.created === snapshot.created)) continue;
        snapshots.push({ snapshot: { ...snapshot, thumbnail: await image(thumbnail) }, state: await read(file) });
    }
    const files = [];
    for (const { name, file } of manifest.files ?? []) files.push({ name, data: await read(file) });

    await transaction(["roms", "romData", "saves", "files"], "readwrite", (tx) => {
        for (const { rom, data: bytes } of roms) {
            tx.objectStore("roms").put(rom);
            tx.objectStore("romData").put({ key: rom.key, data: bytes });
        }
        for (const { id, save } of saves) {
            const request = tx.objectStore("saves").add(save);
            request.onsuccess = () => saveIds.set(id, request.result);
        }
        for (const file of files) tx.objectStore("files").put(file);
    });
    await transaction(["snapshots", "snapshotStates"], "readwrite", (tx) => {
        for (const { snapshot, state } of snapshots) {
            const request = tx.objectStore("snapshots").add({ ...snapshot, saveId: saveIds.get(snapshot.saveId) ?? null });
            request.onsuccess = () => tx.objectStore("snapshotStates").put({ id: request.result, state });
        }
    });
    requestPersistence();
    return { roms: roms.length, saves: saves.length, snapshots: snapshots.length, settings: manifest.settings ?? null };
}

/** A file name without characters that zip tools or file systems dislike. */
function safeName(name) {
    return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 100) || "file";
}
