// Minimal zip reader: stored and deflated entries, no zip64 or encryption.
// Deflate uses the browser's built-in DecompressionStream.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** @typedef {{ name: string, flags: number, method: number, compressedSize: number, size: number, offset: number }} ZipEntry */

export function isZip(data) {
    return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** @returns {ZipEntry[]} */
export function listZip(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const eocd = findEndOfCentralDirectory(view);
    const count = view.getUint16(eocd + 10, true);
    let pos = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    const entries = [];
    for (let i = 0; i < count; i++) {
        if (view.getUint32(pos, true) !== CENTRAL_SIGNATURE) throw new Error("Corrupt zip file.");
        const nameLength = view.getUint16(pos + 28, true);
        entries.push({
            name: decoder.decode(data.subarray(pos + 46, pos + 46 + nameLength)),
            flags: view.getUint16(pos + 8, true),
            method: view.getUint16(pos + 10, true),
            compressedSize: view.getUint32(pos + 20, true),
            size: view.getUint32(pos + 24, true),
            offset: view.getUint32(pos + 42, true),
        });
        pos += 46 + nameLength + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
    }
    return entries;
}

/** @returns {Promise<Uint8Array>} */
export async function extractZipEntry(data, entry) {
    if (entry.flags & 1) throw new Error(`${entry.name} is encrypted.`);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (view.getUint32(entry.offset, true) !== LOCAL_SIGNATURE) throw new Error("Corrupt zip file.");
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    const body = data.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return body.slice();
    if (entry.method === 8) {
        const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error(`Unsupported zip compression method ${entry.method}.`);
}

function findEndOfCentralDirectory(view) {
    const min = Math.max(0, view.byteLength - 22 - 0xffff);
    for (let pos = view.byteLength - 22; pos >= min; pos--) {
        if (view.getUint32(pos, true) === EOCD_SIGNATURE) return pos;
    }
    throw new Error("Corrupt zip file.");
}
