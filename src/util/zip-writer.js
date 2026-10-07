import { crc32 } from './crc32.js';

// Minimal zip writer: stored (uncompressed) entries, UTF-8 names, no zip64
// (so under 4 GB). Readable by src/rom/zip.js and any unzip tool.

/**
 * @param {Array<{ name: string, data: Uint8Array, date?: number }>} entries    date: timestamp in ms.
 * @returns {Blob}
 */
export function createZip(entries) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const { name, data, date = Date.now() } of entries) {
        const nameBytes = encoder.encode(name);
        const crc = crc32(data) >>> 0;
        const [time, day] = dosDateTime(date);
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true);
        local.setUint16(6, 0x0800, true); // UTF-8 names
        local.setUint16(8, 0, true); // stored
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBytes.length, true);
        parts.push(local, nameBytes, data);

        const entry = new DataView(new ArrayBuffer(46));
        entry.setUint32(0, 0x02014b50, true);
        entry.setUint16(4, 20, true);
        entry.setUint16(6, 20, true);
        entry.setUint16(8, 0x0800, true);
        entry.setUint16(12, time, true);
        entry.setUint16(14, day, true);
        entry.setUint32(16, crc, true);
        entry.setUint32(20, data.length, true);
        entry.setUint32(24, data.length, true);
        entry.setUint16(28, nameBytes.length, true);
        entry.setUint32(42, offset, true);
        central.push(entry, nameBytes);
        offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((size, part) => size + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/** MS-DOS time and date fields (local time, 2-second precision). */
function dosDateTime(timestamp) {
    const d = new Date(timestamp);
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return [time, day];
}
